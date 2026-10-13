// JSON control protocol v2. Binary frames carry sequence (u32 BE), offset (u32 BE), then <=1 MiB bytes.
export interface Envelope { sessionId: string; epoch: string }
export interface ActivityMessage { type: "activity"; id: string; tool: string; summary: string }
export type ServerToClientMessage = Envelope & (
  | { type: "welcome"; protocol: 2; activeId: string | null }
  | { type: "execute"; id: string; script: string; expectFiles: boolean }
  | { type: "load_begin"; id: string; filename: string; byteLength: number; sha256: string }
  | { type: "load_end"; id: string }
  | { type: "file_ack"; id: string; offset: number }
  | { type: "transfer_error"; id: string; error: string }
  | { type: "settled"; id: string }
  | ActivityMessage
);
export type ClientToServerMessage =
  | { type: "hello"; protocol: 2; token: string; sessionId: string; ready: boolean }
  | (Envelope & (
    | { type: "status"; ready: boolean }
    | { type: "result"; id: string; success: boolean; data: string | null; error: string | null }
    | { type: "file_begin"; id: string; byteLength: number; sha256: string }
    | { type: "file_end"; id: string }
    | { type: "load_ack"; id: string; offset: number }
  ));
export interface BridgeResult {
  success: boolean;
  data: string | null;
  error: string | null;
  operationId?: string;
  state?: string;
  bundle?: { manifestPath:string; status:'complete'|'incomplete' };
  artifact?: {
    path: string;
    byteLength: number;
    sha256: string;
    format: string;
    validation: "structure_checked";
    width?: number;
    height?: number;
    layerCount?: number;
  };
}

// --- Tool Parameter Types ---

export interface CreateDocumentParams {
  width: number;
  height: number;
  resolution?: number;
  name?: string;
  mode?: string;
  fillColor?: string;
}

export interface ResizeDocumentParams {
  width: number;
  height: number;
}

export interface LayerTarget {
  target: string | number;
}

export interface AddLayerParams {
  name?: string;
  opacity?: number;
  blendMode?: string;
}

export interface AddFillLayerParams {
  type: "solid";
  color?: string;
  name?: string;
}

export interface GradientSpec {
  colors: string[];
  angle?: number;
}

export interface SetLayerPropertiesParams {
  target: string | number;
  opacity?: number;
  blendMode?: string;
  visible?: boolean;
  name?: string;
  locked?: boolean;
}

export interface MoveLayerParams {
  target: string | number;
  x: number;
  y: number;
}

export interface DuplicateLayerParams {
  target: string | number;
  newName?: string;
}

export interface ReorderLayerParams {
  target: string | number;
  position: "above" | "below" | "top" | "bottom";
}

export interface GroupLayersParams {
  layers: string[];
  groupName?: string;
}

export interface AddShapeParams {
  type: "rectangle" | "ellipse";
  bounds: { x: number; y: number; width: number; height: number };
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  name?: string;
}

export interface AddTextParams {
  content: string;
  x: number;
  y: number;
  font?: string;
  size?: number;
  color?: string;
  alignment?: "left" | "center" | "right";
  bold?: boolean;
  italic?: boolean;
  letterSpacing?: number;
  lineHeight?: number;
  paragraphBounds?: { width: number; height: number } | null;
}

export interface EditTextParams {
  target: string | number;
  content?: string;
  font?: string;
  size?: number;
  color?: string;
  alignment?: "left" | "center" | "right";
  letterSpacing?: number;
  lineHeight?: number;
}

export interface PlaceImageParams {
  source: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  name?: string;
}

export interface ApplyAdjustmentParams {
  type: string;
  settings?: Record<string, number | string | boolean>;
}

export interface ApplyFilterParams {
  type: string;
  settings?: Record<string, number | string | boolean>;
}

export interface TransformLayerParams {
  target: string | number;
  scaleX?: number;
  scaleY?: number;
  rotation?: number;
  flipH?: boolean;
  flipV?: boolean;
}

export interface AddGradientParams {
  target: string | number;
  type: "linear";
  colors: string[];
  angle?: number;
}

export interface MakeSelectionParams {
  type: "all" | "rect" | "ellipse";
  bounds?: { x: number; y: number; width: number; height: number };
  feather?: number;
}

export interface ModifySelectionParams {
  action: "expand" | "contract" | "feather" | "invert";
  amount?: number;
}

export interface FillSelectionParams {
  color: string;
  opacity?: number;
  blendMode?: string;
}

export interface ReplaceSmartObjectParams {
  target: string | number;
  source: string;
}

export interface ExportImageParams {
  format: "png" | "jpg" | "webp" | "psd" | "svg";
  quality?: number;
  outputPath: string;
}

// --- Layer Info Types (returned by get_layers) ---

export interface LayerInfo {
  name: string;
  index: number;
  type: string;
  visible: boolean;
  opacity: number;
  bounds: { x: number; y: number; width: number; height: number };
  children?: LayerInfo[];
}

export interface DocumentInfo {
  name: string;
  width: number;
  height: number;
  resolution: number;
  layerCount: number;
  colorMode: string;
}
