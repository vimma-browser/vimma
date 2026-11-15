// The globals httpd.js gives a .sjs handler beyond Firefox's own (Cc, Ci, Services, ChromeUtils,
// URLSearchParams and the rest, in types/firefox.d.ts): the sandbox that
// engine/netwerk/test/httpserver/httpd.sys.mjs builds for each .sjs file imports these functions
// into it. Only tools/sjs-typecheck.ts's program reads this folder, so the mochitests, which run
// in the harness's scope and not in that sandbox, never see them.

/** State kept per handler path across requests; a key never set reads as "". */
declare function getState(key: string): string;
declare function setState(key: string, value: string): void;
/** State shared by every handler of the server; a key never set reads as "". */
declare function getSharedState(key: string): string;
declare function setSharedState(key: string, value: string): void;
declare function getObjectState(key: string, callback: (value: nsISupports | null) => void): void;
declare function setObjectState(key: string, value: nsISupports): void;
declare function dump(text: string): void;

// engine/netwerk/test/httpserver/nsIHttpServer.idl: the request's header names, an
// nsISimpleEnumerator of nsISupportsString (engine/xpcom/ds/nsISimpleEnumerator.idl).
interface nsIHttpRequest {
  readonly headers: { hasMoreElements(): boolean; getNext(): nsISupports };
}
