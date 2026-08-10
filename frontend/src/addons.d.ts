declare module 'three/addons/postprocessing/UnrealBloomPass.js' {
  export class UnrealBloomPass {
    constructor(resolution?: unknown, strength?: number, radius?: number, threshold?: number);
  }
}

declare module 'three' {
  export class FogExp2 {
    constructor(color?: unknown, density?: number);
  }

  export class Vector3 {
    constructor(x?: number, y?: number, z?: number);
    set(x: number, y: number, z: number): this;
    project(camera: unknown): this;
    applyQuaternion(quaternion: unknown): this;
    normalize(): this;
    x: number;
    y: number;
    z: number;
  }
}
