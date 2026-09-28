// Code-split helpers. `lazyChunk` wraps React.lazy with a Suspense fallback and
// an error boundary, so a chunk that cannot load (a tab that outlived a deploy
// and could not reload, see main.tsx's vite:preloadError handler) degrades to
// the fallback instead of unmounting the whole app.
import { Component, lazy, Suspense, type ComponentType, type ReactNode } from "react";

export class ChunkBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- React.lazy's own constraint
export function lazyChunk<C extends ComponentType<any>>(
  load: () => Promise<{ default: C }>,
  fallback: ReactNode = null,
): ComponentType<React.ComponentProps<C>> {
  const Lazy = lazy(load);
  return function LazyChunk(props: React.ComponentProps<C>) {
    return (
      <ChunkBoundary fallback={fallback}>
        <Suspense fallback={fallback}>
          <Lazy {...props} />
        </Suspense>
      </ChunkBoundary>
    );
  };
}
