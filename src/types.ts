// Shared vocabulary for smallcloud.

/** Who an app can be shared with. */
export type Principal =
  | `user:${string}` // one person, by email
  | `domain:${string}` // everyone with an email at this domain
  | 'public'; // anyone who has the link, no sign-in needed

/** What a share lets someone do. The owner is implicitly an editor. */
export type Role = 'user' | 'editor';
// user   = open and use the app
// editor = use it, plus redeploy it, read its source/logs/db, and manage shares

export type EffectiveRole = Role | 'owner';

export interface User {
  email: string;
}

/** What the agent hands over. app.json inside the bundle. */
export interface Manifest {
  name: string;
  description?: string;
}

export interface AppFile {
  path: string; // posix, relative to the bundle root: "public/index.html", "api/todos.js", "app.json"
  content: string;
  encoding?: 'utf8' | 'base64';
}

export interface AppRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  ownerEmail: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface Share {
  appId: string;
  principal: Principal;
  role: Role;
}

/** The request an api route receives (serialized to the sandbox). */
export interface RouteRequest {
  method: string;
  path: string; // path after /api, e.g. "/todos/12"
  route: string; // first path segment, selects api/<route>.js
  subpath: string; // remainder after the route segment, e.g. "/12"
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | null;
}

/** What a route returns. A plain string is HTML; a Buffer is bytes. */
export interface RouteResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  bodyB64?: string;
  json?: unknown;
}

export interface LogLine {
  at: number;
  level: 'info' | 'error';
  msg: string;
}
