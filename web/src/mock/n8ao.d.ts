// n8ao ships no types; the one class this app uses (Scene3D's AO), with the settings it sets.
declare module "n8ao" {
  import type { Camera, Scene } from "three";
  import { Pass } from "three/examples/jsm/postprocessing/Pass.js";
  export class N8AOPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: { aoRadius: number; distanceFalloff: number; intensity: number; gammaCorrection: boolean; halfRes: boolean; [k: string]: unknown };
  }
}
