import {
  Component,
  Suspense,
  createElement,
  lazy,
  useSyncExternalStore,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";

type ModuleRecord = Record<string, unknown>;
type RouteComponent = ComponentType<any>;
export type LazyRouteComponent = RouteComponent & { retry: () => void };

function resolveComponent(module: ModuleRecord, exportName?: string): RouteComponent {
  const candidate = exportName ? module[exportName] : module.default;

  if (typeof candidate !== "function" && typeof candidate !== "object") {
    throw new Error(`lazyRoute: missing export "${exportName ?? "default"}"`);
  }

  return candidate as RouteComponent;
}

export function lazyRoute(
  loader: () => Promise<unknown>,
  exportName?: string,
): LazyRouteComponent {
  const createLazyComponent = () =>
    lazy(async () => {
      const module = (await loader()) as ModuleRecord;

      return { default: resolveComponent(module, exportName) };
    });

  let LazyComponent = createLazyComponent();
  const listeners = new Set<() => void>();
  const subscribe = (listener: () => void) => {
    listeners.add(listener);

    return () => {
      listeners.delete(listener);
    };
  };
  const getSnapshot = () => LazyComponent;

  function LazyRoute(props: Record<string, unknown>) {
    const ComponentToRender = useSyncExternalStore(
      subscribe,
      getSnapshot,
      getSnapshot,
    );

    return createElement(ComponentToRender, props);
  }

  LazyRoute.retry = () => {
    LazyComponent = createLazyComponent();
    listeners.forEach((listener) => listener());
  };

  return LazyRoute;
}

export function RouteFallback({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="route-fallback" role="status" aria-live="polite" aria-busy="true">
      <span className="route-fallback__label">{label}</span>
    </div>
  );
}

type RouteErrorBoundaryProps = {
  children?: ReactNode;
  fallbackMessage?: string;
  onRetry?: () => void;
};

type RouteErrorBoundaryState = {
  hasError: boolean;
};

export function RouteBoundary({
  children,
  label,
  onRetry,
}: {
  children: ReactNode;
  label?: string;
  onRetry?: () => void;
}) {
  return (
    <RouteErrorBoundary onRetry={onRetry}>
      <Suspense fallback={<RouteFallback label={label} />}>{children}</Suspense>
    </RouteErrorBoundary>
  );
}

export class RouteErrorBoundary extends Component<
  RouteErrorBoundaryProps,
  RouteErrorBoundaryState
> {
  state: RouteErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): RouteErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("RouteErrorBoundary caught:", error, info);
  }

  handleRetry = () => {
    this.props.onRetry?.();
    this.setState({ hasError: false });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="route-error" role="alert">
          <p>{this.props.fallbackMessage ?? "Something went wrong. Please retry."}</p>
          <button className="btn secondary compact" onClick={this.handleRetry}>
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
