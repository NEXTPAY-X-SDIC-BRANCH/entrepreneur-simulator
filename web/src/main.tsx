import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import "./styles/base.css";

const Mock = lazy(() => import("./mock/Mock"));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Mock />
    </Suspense>
  </StrictMode>,
);
