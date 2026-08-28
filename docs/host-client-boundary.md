# Host and Client Boundary

English | [中文](host-client-boundary.zh.md)

## Host authority

Only Host plugins may directly access Node.js, the filesystem, subprocesses, PTYs, environment variables, credentials, persistent databases, Electron, and local network listeners. Host methods validate paths, identity, ownership, and cancellation before performing privileged operations.

## Client authority

Client plugins run in the browser. They:

- access Session and Workspace projections through the Client Runtime;
- call the Host through Typert-generated Remotes;
- contribute UI through the Slot Registry;
- contribute copy through the Locale Registry;
- never import Host implementations or Node.js built-ins.

## Remotes

Remote descriptors are the type source of truth across the Host/Client boundary. The Host Gateway validates arguments and selects the receiver; the Client validates results and binds call lifetime. Every new Remote includes:

- an explicit namespace and method name;
- JSON-safe arguments and results;
- injected `AbortSignal` support when needed;
- Host-side authorization instead of a hidden UI button alone;
- at least one cross-boundary failure case.

## Electron

The Electron main process owns only windows, security policy, single-instance behavior, runtime supervision, and desktop-specific bridges. Agent, Session, Tools, and database services never create a second architecture through custom Electron IPC.

WebView navigation, permissions, and new windows are denied by default in the main process and then delegated to the controlled desktop-browser bridge.
