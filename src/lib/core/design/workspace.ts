/**
 * The seam between the generic document and the workspaces that fill it.
 *
 * `core` may not import a feature, yet the document has to name each
 * workspace's data precisely enough for the compiler to check it. So this
 * interface starts empty and every feature adds its own entry through module
 * augmentation:
 *
 * ```ts
 * declare module '$lib/core/design/workspace.js' {
 * 	interface WorkspaceDataMap {
 * 		packaging: PackagingData;
 * 	}
 * }
 * ```
 *
 * The map is then a property of the whole program rather than a dependency
 * edge from core to features.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- augmented by features
export interface WorkspaceDataMap {}

/** A workspace some feature has registered. */
export type WorkspaceId = keyof WorkspaceDataMap & string;

/**
 * Each workspace's data, present only for workspaces the document actually
 * uses — a document with no packaging sheet carries no deck.
 */
export type WorkspaceData = { readonly [K in WorkspaceId]?: WorkspaceDataMap[K] };
