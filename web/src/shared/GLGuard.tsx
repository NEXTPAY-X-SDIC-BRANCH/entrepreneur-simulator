// No-WebGL guard for every three.js canvas. A browser without WebGL (GPU blocklisted, hardware acceleration off,
// GL_VENDOR=Disabled) makes R3F's <Canvas> throw, and an uncaught render error unmounts the whole page. GLGuard
// probes WebGL once up front and catches anything the canvas (or its lazy chunk) throws later, and shows a calm
// light panel in the canvas's place; the rest of the screen keeps working without the 3D store.
// No three.js import here, so a browser without WebGL never downloads it.
import { Component, type ReactNode } from "react";
import "./glguard.css";

let glOk: boolean | null = null;

// true when this browser can create a WebGL context; probed once on a throwaway canvas, false after any canvas failure
export function hasWebGL(): boolean {
  if (glOk !== null) return glOk;
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    glOk = Boolean(gl);
    gl?.getExtension("WEBGL_lose_context")?.loseContext(); // hand the probe's context back
  } catch {
    glOk = false;
  }
  return glOk;
}

export function GLFallback() {
  return (
    <div className="gl-fallback" data-testid="gl-fallback" role="note">
      <div className="gl-fallback-card">
        <svg viewBox="0 0 48 40" aria-hidden="true">
          <path d="M6 16 10 4h28l4 12" />
          <path d="M6 16v20h36V16" />
          <path d="M6 16q4.5 5 9 0q4.5 5 9 0q4.5 5 9 0q4.5 5 9 0" />
          <path d="M19 36V25h10v11" />
        </svg>
        <p>이 브라우저에서 3D 화면을 켤 수 없습니다. 브라우저를 다시 시작하거나 하드웨어 가속을 켜 주세요</p>
      </div>
    </div>
  );
}

class GLBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    glOk = false; // later mounts go straight to the fallback instead of failing again
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn("3D canvas failed, showing the static fallback:", error);
  }
  render() {
    return this.state.failed ? <GLFallback /> : this.props.children;
  }
}

// wrap the lazy canvas (and its Suspense) in this: no WebGL, or the canvas throws, and the fallback takes its place
export function GLGuard({ children }: { children: ReactNode }) {
  return hasWebGL() ? <GLBoundary>{children}</GLBoundary> : <GLFallback />;
}
