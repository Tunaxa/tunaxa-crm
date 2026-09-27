import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const dockerfilePath = path.join(root, 'Dockerfile');
const dockerignorePath = path.join(root, '.dockerignore');

const dockerfileText = fs.readFileSync(dockerfilePath, 'utf8');
const dockerignoreText = fs.readFileSync(dockerignorePath, 'utf8');

/**
 * Minimal Dockerfile reader.
 *
 * Two details matter and both are easy to get wrong with a naive split:
 *
 *   - Only whole-line comments are stripped. A `#` after an instruction is an
 *     argument, not a comment, so `RUN foo # bar` keeps its trailing text.
 *   - Line continuations are joined before instructions are parsed, so an
 *     instruction spanning several lines is seen as one.
 *
 * That is enough to answer the questions these tests ask without pulling in a
 * Dockerfile parser dependency.
 */
function parseDockerfile(text) {
  const logical = [];
  // Continuation state is kept separately from `logical`. A continued block
  // (ENV ... \ / HEALTHCHECK ... \ CMD) is routinely preceded by comment lines,
  // which are dropped above, so the block being continued is not the last
  // element of `logical` - and may not be in it at all. Accumulating into
  // `logical[logical.length - 1]` would silently discard those instructions.
  let pending = '';

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.endsWith('\\')) {
      pending = pending ? `${pending} ${line.slice(0, -1).trim()}` : line.slice(0, -1).trim();
      continue;
    }
    logical.push(pending ? `${pending} ${line}` : line);
    pending = '';
  }
  if (pending) logical.push(pending);

  const instructions = logical.map((line, index) => {
    const match = line.match(/^([A-Za-z]+)\s+(.*)$/);
    return {
      index,
      keyword: (match?.[1] || '').toUpperCase(),
      args: match?.[2] || '',
      raw: line,
      stage: null,
    };
  });

  // Tag each instruction with the stage declared by the most recent FROM.
  let current = null;
  for (const instruction of instructions) {
    if (instruction.keyword === 'FROM') {
      const asMatch = instruction.args.match(/\bAS\s+(\S+)$/i);
      current = asMatch ? asMatch[1] : '<unnamed>';
    }
    instruction.stage = current;
  }

  const stages = [];
  for (const instruction of instructions) {
    if (instruction.keyword !== 'FROM') continue;
    const asMatch = instruction.args.match(/\bAS\s+(\S+)$/i);
    const name = asMatch ? asMatch[1] : '<unnamed>';
    stages.push({
      name,
      image: instruction.args.replace(/\s+AS\s+\S+$/i, ''),
      instructions: instructions.filter((i) => i.stage === name),
    });
  }

  return { instructions, stages };
}

const { instructions, stages } = parseDockerfile(dockerfileText);
const finalStage = stages[stages.length - 1];
const builderStage = stages.find((s) => s !== finalStage && s.instructions.some((i) => i.keyword === 'RUN'));

const inFinal = (keyword) => finalStage.instructions.filter((i) => i.keyword === keyword);

describe('Dockerfile multi-stage structure', () => {
  it('declares at least two named stages', () => {
    expect(stages.length).toBeGreaterThanOrEqual(2);
    for (const stage of stages) {
      expect(stage.name).not.toBe('<unnamed>');
    }
  });

  it('separates a build stage from the final runtime stage', () => {
    expect(builderStage).toBeDefined();
    expect(builderStage.name).not.toBe(finalStage.name);
    // The build stage is where the toolchain lives.
    expect(builderStage.instructions.some((i) => i.keyword === 'RUN' && /npm (ci|install)/.test(i.args))).toBe(true);
  });

  it('installs dependencies from the lockfile with npm ci', () => {
    const install = builderStage.instructions.find((i) => i.keyword === 'RUN' && /npm ci/.test(i.args));
    expect(install).toBeDefined();
    expect(install.args).toMatch(/--no-audit/);
  });

  it('copies package.json and package-lock.json before installing', () => {
    const copyIndex = builderStage.instructions.findIndex(
      (i) => i.keyword === 'COPY' && /package-lock\.json/.test(i.args),
    );
    const installIndex = builderStage.instructions.findIndex((i) => i.keyword === 'RUN' && /npm ci/.test(i.args));
    expect(copyIndex).toBeGreaterThanOrEqual(0);
    expect(installIndex).toBeGreaterThan(copyIndex);
  });

  it('prunes devDependencies before the stage boundary', () => {
    const prune = builderStage.instructions.find((i) => i.keyword === 'RUN' && /npm prune/.test(i.args));
    expect(prune).toBeDefined();
    expect(prune.args).toMatch(/--omit=dev/);
  });

  it('builds the frontend in the build stage only', () => {
    const build = builderStage.instructions.find((i) => i.keyword === 'RUN' && /npm run build/.test(i.args));
    expect(build).toBeDefined();
    expect(inFinal('RUN').some((i) => /npm run build/.test(i.args))).toBe(false);
  });

  it('copies node_modules from the build stage into the runtime stage', () => {
    const copy = inFinal('COPY').find((i) => /--from=/.test(i.args) && /node_modules/.test(i.args));
    expect(copy).toBeDefined();
    // It must come from the build stage, not from the host build context.
    expect(copy.args).toMatch(new RegExp(`--from=${builderStage.name}`));
  });

  it('copies the built frontend bundle into the runtime stage', () => {
    const copy = inFinal('COPY').find((i) => /web\/dist/.test(i.args));
    expect(copy).toBeDefined();
    expect(copy.args).toMatch(/--from=/);
  });

  it('copies the application source and root manifest into the runtime stage', () => {
    const copies = inFinal('COPY').map((i) => i.args);
    expect(copies.some((a) => /\bbackend\b/.test(a))).toBe(true);
    expect(copies.some((a) => /package\.json/.test(a))).toBe(true);
  });
});

describe('Dockerfile security and non-root execution', () => {
  it('switches to the node user', () => {
    const users = inFinal('USER');
    expect(users).toHaveLength(1);
    expect(users[0].args.trim()).toBe('node');
  });

  it('sets USER after every COPY and ADD in the runtime stage', () => {
    const userIndex = inFinal('USER')[0].index;
    const copies = finalStage.instructions.filter((i) => i.keyword === 'COPY' || i.keyword === 'ADD');
    expect(copies.length).toBeGreaterThan(0);
    for (const copy of copies) {
      expect(copy.index).toBeLessThan(userIndex);
    }
  });

  it('sets ownership to node:node so no root-owned files remain', () => {
    const copies = inFinal('COPY');
    for (const copy of copies) {
      expect(copy.args).toMatch(/--chown=node:node/);
    }
  });

  it('never returns to root in the runtime stage', () => {
    const asRoot = instructions.filter((i) => i.keyword === 'USER' && /root/i.test(i.args));
    expect(asRoot).toHaveLength(0);
  });

  it('uses tini as PID 1 so SIGTERM reaches the shutdown handler', () => {
    // backend/server.js stops the email, transcription and report-scheduler
    // workers on SIGTERM. Without an init shim that handler never runs.
    const entrypoint = inFinal('ENTRYPOINT');
    expect(entrypoint).toHaveLength(1);
    expect(entrypoint[0].args).toMatch(/tini/);
  });

  it('installs tini in the runtime stage, not only in the build stage', () => {
    // Each FROM starts from a clean base image, so a package installed in the
    // build stage is absent in the runner and the entrypoint dies with
    // "no such file or directory". Asserting the entrypoint mentions tini is
    // not enough; the package has to be installed where it runs.
    const install = inFinal('RUN').find((i) => /apk add/.test(i.args) && /tini/.test(i.args));
    expect(install).toBeDefined();
  });

  it('uses exec form for ENTRYPOINT and CMD so no shell wrapper blocks signals', () => {
    const entrypoint = inFinal('ENTRYPOINT')[0];
    const cmd = inFinal('CMD')[0];
    expect(entrypoint.raw).toMatch(/^ENTRYPOINT\s+\[/);
    expect(cmd.raw).toMatch(/^CMD\s+\[/);
  });

  it('starts backend/server.js rather than the development launcher', () => {
    const cmd = inFinal('CMD')[0];
    expect(cmd.args).toMatch(/backend\/server\.js/);
    // start.js spawns a Vite dev server and hardcodes port 3001 - it is the dev
    // launcher and has no place in a production image.
    expect(cmd.args).not.toMatch(/start\.js/);
  });
});

describe('Dockerfile environment and networking', () => {
  it('declares NODE_ENV=production in the runtime stage', () => {
    const env = inFinal('ENV').flatMap((i) => i.args.split(/\s+/));
    expect(env).toContain('NODE_ENV=production');
  });

  it('exposes port 3000', () => {
    const expose = inFinal('EXPOSE');
    expect(expose).toHaveLength(1);
    expect(expose[0].args.trim().split(/\s+/)).toContain('3000');
  });

  it('keeps the exposed port and the listening port in agreement', () => {
    const env = inFinal('ENV').flatMap((i) => i.args.split(/\s+/));
    const port = env.find((a) => a.startsWith('PORT='));
    const exposed = inFinal('EXPOSE')[0].args.trim().split(/\s+/);
    // EXPOSE is only documentation; if PORT disagreed with it, the mapping would
    // publish a port nothing listens on.
    expect(port).toBe(`PORT=${exposed[0]}`);
  });

  it('binds 0.0.0.0 in the runtime stage', () => {
    // The server defaults to 127.0.0.1, which is unreachable from outside a
    // container no matter what the port mapping says.
    const env = inFinal('ENV').flatMap((i) => i.args.split(/\s+/));
    expect(env).toContain('HOST=0.0.0.0');
  });

  it('declares a healthcheck against the /api/health endpoint', () => {
    const healthcheck = inFinal('HEALTHCHECK');
    expect(healthcheck).toHaveLength(1);
    expect(healthcheck[0].args).toMatch(/\/api\/health/);
    // wget comes from busybox, which node:22-alpine already ships.
    expect(healthcheck[0].args).toMatch(/wget/);
  });

  it('probes the port it exposes', () => {
    // A healthcheck pointed at the wrong port reports unhealthy against a
    // perfectly good server, which is worse than having no healthcheck at all.
    const healthcheck = inFinal('HEALTHCHECK')[0];
    const exposed = inFinal('EXPOSE')[0].args.trim().split(/\s+/);
    for (const port of exposed) {
      expect(healthcheck.args).toMatch(new RegExp(`:${port}\\b`));
    }
  });

  it('uses short wget flags that busybox actually supports', () => {
    const healthcheck = inFinal('HEALTHCHECK')[0];
    // busybox wget rejects the GNU long options, which would make the
    // healthcheck fail for a reason unrelated to the app.
    expect(healthcheck.args).not.toMatch(/--quiet|--output-document/);
  });

  it('uses the node:22-alpine base image for both stages', () => {
    for (const stage of stages) {
      expect(stage.image).toMatch(/^node:22-alpine/);
    }
  });
});

describe('.dockerignore coverage', () => {
  it('exists and is not empty', () => {
    expect(fs.existsSync(dockerignorePath)).toBe(true);
    expect(dockerignoreText.trim().length).toBeGreaterThan(0);
  });

  it('excludes version control metadata', () => {
    expect(dockerignoreText).toMatch(/^\.git$/m);
    expect(dockerignoreText).toMatch(/^\.github$/m);
  });

  it('excludes host-installed dependencies', () => {
    expect(dockerignoreText).toMatch(/^node_modules$/m);
  });

  it('excludes secrets so they cannot be baked into a layer', () => {
    expect(dockerignoreText).toMatch(/^\.env$/m);
    expect(dockerignoreText).toMatch(/^\.env\.\*$/m);
  });

  it('excludes test sources and coverage output', () => {
    expect(dockerignoreText).toMatch(/__tests__/);
    expect(dockerignoreText).toMatch(/\*\.test\.js/);
    expect(dockerignoreText).toMatch(/^coverage$/m);
  });

  it('keeps the lockfile, which npm ci requires', () => {
    // Excluding package-lock.json would make `npm ci` fail outright, and
    // excluding it silently is the classic way a .dockerignore breaks a build.
    expect(dockerignoreText).not.toMatch(/^\/?package-lock\.json$/m);
  });

  it('keeps the application source directories', () => {
    expect(dockerignoreText).not.toMatch(/^\/backend$/m);
    expect(dockerignoreText).not.toMatch(/^\/?web$/m);
  });
});

describe('server container-readiness contract', () => {
  // The Dockerfile is only correct if backend/server.js honours the two
  // variables it sets, so these are asserted against the source rather than
  // against the image.
  const serverText = fs.readFileSync(path.join(root, 'backend', 'server.js'), 'utf8');

  it('reads PORT from the environment, defaulting to the dev port', () => {
    expect(serverText).toMatch(/process\.env\.PORT/);
    // The default must stay 3001 so start.js and the Vite proxy keep working.
    expect(serverText).toMatch(/Number\(process\.env\.PORT\)\s*\|\|\s*3001/);
  });

  it('reads HOST from the environment, defaulting to loopback', () => {
    expect(serverText).toMatch(/process\.env\.HOST\s*\|\|\s*"127\.0\.0\.1"/);
  });

  it('serves the built frontend when a bundle is present', () => {
    expect(serverText).toMatch(/web.*dist|webDist/i);
    expect(serverText).toMatch(/express\.static/);
  });

  it('keeps the SPA fallback away from the API and upload routes', () => {
    // Without this, an unknown /api route would return the HTML shell instead
    // of a JSON 404.
    expect(serverText).toMatch(/startsWith\("\/api"\)/);
    expect(serverText).toMatch(/startsWith\("\/uploads"\)/);
  });

  it('keeps the health endpoint the check depends on', () => {
    const authText = fs.readFileSync(path.join(root, 'backend', 'routes', 'auth.js'), 'utf8');
    expect(authText).toMatch(/'\/api\/health'/);
  });
});

describe('build toolchain stays out of the runtime image', () => {
  // `npm prune --omit=dev` can only remove what the lockfile marks dev-only, and
  // npm derives that from package.json. A build-time tool listed in
  // `dependencies` is therefore *correctly* treated as a production dependency
  // and survives the prune.
  //
  // @vitejs/plugin-react is the specific trap: it is a Vite plugin, needed only
  // by `npm run build`, but it declares `vite` as a peer dependency. With the
  // plugin in `dependencies`, npm resolves vite into the production graph, and
  // rollup and esbuild come with it as vite's own dependencies. The result is a
  // runtime image carrying a bundler, a linter and a test runner, and
  // `test -d node_modules/vite` inside the image succeeds when it must fail.
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const deps = pkg.dependencies || {};
  const devDeps = pkg.devDependencies || {};

  it('keeps @vitejs/plugin-react in devDependencies, not dependencies', () => {
    expect(deps['@vitejs/plugin-react']).toBeUndefined();
    expect(devDeps['@vitejs/plugin-react']).toBeDefined();
  });

  it('keeps the bundler and test runner dev-only', () => {
    for (const name of ['vite', 'vitest', 'eslint', 'typescript', 'tailwindcss']) {
      expect(deps[name], `${name} is a build/test tool and must not be a runtime dependency`).toBeUndefined();
    }
  });

  it('supplies the Alpine native binaries the lockfile omits', () => {
    // package-lock.json is Windows-generated: it records only
    // @rollup/rollup-win32-* and @esbuild/win32-x64. `npm ci` installs the
    // lockfile exactly, so on node:22-alpine the @rollup and @esbuild
    // directories come out empty and the build dies with
    // "Cannot find module @rollup/rollup-linux-x64-musl" (npm/cli#4828).
    const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const lockPackages = Object.keys(lock.packages || {});

    // The Dockerfile has to compensate, and it has to name the musl variant,
    // because Alpine is musl rather than glibc.
    expect(dockerfileText).toMatch(/@rollup\/rollup-linux-x64-musl/);
    expect(dockerfileText).toMatch(/@esbuild\/linux-x64/);

    // And the versions must come from the installed packages rather than being
    // hardcoded, so a dependency bump cannot silently desynchronise them.
    expect(dockerfileText).toMatch(/rollup-linux-x64-musl@\$\(/);
    expect(dockerfileText).toMatch(/esbuild\/linux-x64@\$\(/);

    // Guards the premise of the workaround: if the lockfile ever starts
    // carrying the Linux variants, the Dockerfile step is dead weight and this
    // assertion is what tells us to remove it.
    const hasMuslRollup = lockPackages.includes('node_modules/@rollup/rollup-linux-x64-musl');
    const hasLinuxEsbuild = lockPackages.includes('node_modules/@esbuild/linux-x64');
    expect(
      hasMuslRollup && hasLinuxEsbuild,
      'package-lock.json now contains the Linux platform binaries, so the Dockerfile ' +
        'step that installs them can be dropped',
    ).toBe(false);
  });
});

// Runs only where a Docker daemon exists. The static assertions above are the
// portable guardrail; this confirms the image actually builds and runs as node.
function dockerAvailable() {
  try {
    const result = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 20000 });
    return result.status === 0;
  } catch {
    return false;
  }
}

const hasDocker = dockerAvailable();

describe.skipIf(!hasDocker)('local image build', () => {
  const image = 'tunaxa-crm:test';

  it('builds the image', () => {
    const result = spawnSync('docker', ['build', '-t', image, '.'], { encoding: 'utf8', timeout: 900000 });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  }, 900000);

  it('runs as the node user', () => {
    const result = spawnSync('docker', ['run', '--rm', '--entrypoint', 'whoami', image], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('node');
  });

  it('sets NODE_ENV=production', () => {
    const result = spawnSync('docker', ['run', '--rm', '--entrypoint', 'env', image], { encoding: 'utf8' });
    expect(result.stdout).toMatch(/NODE_ENV=production/);
  });

  it('ships no test files and no dev dependencies', () => {
    const tests = spawnSync('docker', ['run', '--rm', '--entrypoint', 'sh', image, '-c', 'ls backend/__tests__'], {
      encoding: 'utf8',
    });
    expect(tests.status).not.toBe(0);
    const vite = spawnSync('docker', ['run', '--rm', '--entrypoint', 'sh', image, '-c', 'test -d node_modules/vite'], {
      encoding: 'utf8',
    });
    expect(vite.status).not.toBe(0);
  });

  it('answers the health endpoint on the exposed port', () => {
    const name = 'tunaxa-crm-healthcheck';
    const result = spawnSync('docker', ['run', '--rm', '-d', '--name', name, '-p', '3000:3000', image], {
      encoding: 'utf8',
      timeout: 120000,
    });
    expect(result.status, result.stderr).toBe(0);
    try {
      // `docker run -d` returns as soon as the container is created, well
      // before node has bound the port. Probing once therefore races startup
      // and fails intermittently on a container that is perfectly healthy - it
      // took ~2s to answer on the machine this was written on, against a probe
      // issued at t=0. So poll for the endpoint instead.
      //
      // The assertion is unchanged and just as strict: the loop still has to
      // observe a body matching "ok": true, and a container that never serves
      // it fails below once the deadline passes. Only the waiting changes.
      const deadline = Date.now() + 60000;
      let body = '';
      let attempts = 0;
      while (Date.now() < deadline) {
        const probe = spawnSync('docker', ['exec', name, 'wget', '-q', '-O', '-', 'http://127.0.0.1:3000/api/health'], {
          encoding: 'utf8',
          timeout: 20000,
        });
        attempts += 1;
        if (probe.status === 0 && probe.stdout) {
          body = probe.stdout;
          break;
        }
        // Busybox wget returns non-zero while the port is still closed.
        // Atomics.wait is a synchronous sleep; spawning a shell per attempt
        // would cost more than the wait itself.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      }

      const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
      expect(attempts, `container never answered /api/health after ${attempts} attempts; logs: ${logs.stderr || logs.stdout}`).toBeGreaterThan(0);
      expect(body).toMatch(/"ok"\s*:\s*true/);
    } finally {
      spawnSync('docker', ['rm', '-f', name], { encoding: 'utf8' });
    }
  }, 180000);
});

describe.skipIf(hasDocker)('local image build (skipped)', () => {
  it('reports why the image build could not be exercised', () => {
    // Not a failure: the environment has no Docker daemon. The static
    // assertions in this file are the guardrail that runs everywhere.
    expect(hasDocker).toBe(false);
  });
});
