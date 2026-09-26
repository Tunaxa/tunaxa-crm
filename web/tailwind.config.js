import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'src/**/*.{js,ts,jsx,tsx}').replace(/\\/g, '/'),
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        tunaxa: {
          // Canvas & Surface
          light: '#f7f7f7',
          surface: '#ffffff',
          dark: '#0a0e14',
          'dark-surface': '#111622',
          // Sapphire-to-Indigo Spectrum (Design System v2.0)
          'sapphire-light': '#60a5fa',
          sapphire: '#3b82f6',
          royal: '#2563eb',
          cobalt: '#1d4ed8',
          indigo: '#1e3a8a',
          obsidian: '#1e1b4b',
          // Per-Product Refraction Accents
          coral: '#f43f5e',     // AXA CRM — Coral Surge
          cyan: '#06b6d4',      // AXA Workspace
          violet: '#8b5cf6',    // AXA Pass
          amber: '#f59e0b',     // AXA Sign
          sky: '#38bdf8',       // AXA Book
        },
      },
      fontFamily: {
        mono: ['Geist Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  corePlugins: {
    preflight: false,
  },
};
