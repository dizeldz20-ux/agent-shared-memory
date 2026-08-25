declare module 'three/addons/postprocessing/UnrealBloomPass.js' {
  export class UnrealBloomPass {
    constructor(resolution?: unknown, strength?: number, radius?: number, threshold?: number);
  }
}

declare module 'three/addons/lines/LineSegmentsGeometry.js' {
  export class LineSegmentsGeometry {
    instanceCount: number;
    setPositions(array: Float32Array | number[]): this;
    setColors(array: Float32Array | number[]): this;
    getAttribute(name: string): {
      data?: {
        needsUpdate: boolean;
        setUsage(usage: number): unknown;
      };
      needsUpdate: boolean;
    } | undefined;
    dispose(): void;
  }
}

declare module 'three/addons/lines/LineMaterial.js' {
  export class LineMaterial {
    constructor(parameters?: Record<string, unknown>);
    linewidth: number;
    opacity: number;
    dispose(): void;
  }
}

declare module 'three/addons/lines/LineSegments2.js' {
  import type { LineMaterial } from 'three/addons/lines/LineMaterial.js';
  import type { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';

  export class LineSegments2 {
    constructor(geometry?: LineSegmentsGeometry, material?: LineMaterial);
    geometry: LineSegmentsGeometry;
    material: LineMaterial;
    name: string;
    renderOrder: number;
    frustumCulled: boolean;
  }
}

declare module 'three' {
  export const AdditiveBlending: number;
  export const DoubleSide: number;
  export const DynamicDrawUsage: number;
  export const FrontSide: number;

  export interface BufferAttribute {
    array: ArrayLike<number>;
    data?: {
      needsUpdate: boolean;
      setUsage(usage: number): unknown;
    };
    needsUpdate: boolean;
  }

  export class BufferGeometry {
    setAttribute(name: string, attribute: unknown): this;
    getAttribute(name: string): BufferAttribute | undefined;
    setIndex(index: unknown): this;
    setDrawRange(start: number, count: number): void;
    computeVertexNormals(): void;
    dispose(): void;
  }

  export class CanvasTexture {
    constructor(canvas: HTMLCanvasElement);
  }

  export class Color {
    constructor(color?: unknown);
    constructor(r: number, g: number, b: number);
    r: number;
    g: number;
    b: number;
  }

  export class Float32BufferAttribute {
    constructor(array: ArrayLike<number>, itemSize: number);
  }

  export class FogExp2 {
    constructor(color?: unknown, density?: number);
  }

  export class PointsMaterial {
    constructor(parameters?: Record<string, unknown>);
    opacity: number;
    dispose(): void;
  }

  export class Points {
    constructor(geometry?: BufferGeometry, material?: PointsMaterial);
    name: string;
    renderOrder: number;
    frustumCulled: boolean;
  }

  export class LineBasicMaterial {
    constructor(parameters?: Record<string, unknown>);
    opacity: number;
    dispose(): void;
  }

  export class LineSegments {
    constructor(geometry?: BufferGeometry, material?: LineBasicMaterial);
    geometry: BufferGeometry;
    material: LineBasicMaterial;
    name: string;
    renderOrder: number;
  }

  export class ShaderMaterial {
    constructor(parameters?: Record<string, unknown>);
    uniforms: Record<string, { value: unknown }>;
    dispose(): void;
  }

  export class Mesh {
    constructor(geometry?: BufferGeometry, material?: ShaderMaterial);
    name: string;
    renderOrder: number;
  }

  export class SpriteMaterial {
    constructor(parameters?: Record<string, unknown>);
    dispose(): void;
  }

  export class Sprite {
    constructor(material?: SpriteMaterial);
    scale: { set(x: number, y: number, z: number): void };
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
