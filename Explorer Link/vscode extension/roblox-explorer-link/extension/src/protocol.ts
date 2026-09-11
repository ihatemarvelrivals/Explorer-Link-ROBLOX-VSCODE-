/**
 * Wire types for protocol v1. Mirrors docs/PROTOCOL.md; change both together.
 */

export const PROTOCOL_VERSION = 1;

export interface Hello {
  protocol: number;
  pluginVersion: string;
  placeName: string;
  placeId: number;
  studioVersion: string;
  isEditMode: boolean;
}

export interface NodeFlags {
  script: boolean;
  disabled: boolean;
  service: boolean;
}

export interface RbxNode {
  ref: string;
  name: string;
  className: string;
  path: string;
  /** Ancestry filtered to the classes the icon map knows, most specific first. */
  tags: string[];
  childCount: number;
  flags: NodeFlags;
}

export interface PropertyRow {
  key: string;
  value: string;
  kind: string;
}

export interface PropertyGroup {
  name: string;
  rows: PropertyRow[];
}

export type CommandType =
  | 'ping'
  | 'getGeometry'
  | 'getChildren'
  | 'getProperties'
  | 'getSource'
  | 'releaseSource'
  | 'subscribe'
  | 'unsubscribe'
  | 'select'
  | 'revealInStudio'
  | 'resolvePath'
  | 'stats';

export interface Command {
  id: number;
  type: CommandType;
  [key: string]: unknown;
}

export interface ResultEvent {
  type: 'result';
  id: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface RootsEvent {
  type: 'roots';
  nodes: RbxNode[];
}

export interface ChildAddedEvent {
  type: 'childAdded';
  parent: string;
  node: RbxNode;
  index: number;
}

export interface ChildRemovedEvent {
  type: 'childRemoved';
  parent: string;
  ref: string;
}

export interface NodeChangedEvent {
  type: 'nodeChanged';
  node: RbxNode;
}

export interface SelectionChangedEvent {
  type: 'selectionChanged';
  refs: string[];
  /** One array of name segments per selected instance, root-first, excluding `game`. */
  paths: string[][];
}

export interface SourceChangedEvent {
  type: 'sourceChanged';
  ref: string;
}

export interface PlaceChangedEvent {
  type: 'placeChanged';
  placeName: string;
  placeId: number;
}

export interface ByeEvent {
  type: 'bye';
  reason: string;
}

export type PluginEvent =
  | ResultEvent
  | RootsEvent
  | ChildAddedEvent
  | ChildRemovedEvent
  | NodeChangedEvent
  | SelectionChangedEvent
  | SourceChangedEvent
  | PlaceChangedEvent
  | ByeEvent;

export interface GetChildrenResult {
  nodes: RbxNode[];
}

export interface GetPropertiesResult {
  groups: PropertyGroup[];
}

export interface GetSourceResult {
  source: string;
  name: string;
  className: string;
  path: string;
}

export interface ResolvePathResult {
  ref: string | null;
}

/** One BasePart, reduced to what a preview needs to draw it. */
export interface GeometryPart {
  name: string;
  className: string;
  /** 'box' | 'ball' | 'cylinder' | 'wedge' | 'cornerwedge'. */
  shape: string;
  /**
   * True when the shape is a stand-in rather than the real geometry: meshes and unions
   * have no vertices a plugin can read, so they arrive as their bounding box.
   */
  approximate: boolean;
  size: [number, number, number];
  /** CFrame:GetComponents order — x, y, z, then the rotation matrix row by row. */
  cframe: number[];
  color: [number, number, number];
  transparency: number;
  material: string;
}

export interface GetGeometryResult {
  name: string;
  className: string;
  path: string;
  parts: GeometryPart[];
  /** How many of `parts` are bounding-box stand-ins. */
  approximated: number;
  /** True when the walk hit its part or visit budget before finishing. */
  truncated: boolean;
  maxParts: number;
}
