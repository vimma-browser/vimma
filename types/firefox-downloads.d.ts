// The Firefox modules the agent's downloads (ctl/AgentDownloads.sys.mjs) and the agent pages'
// hooks (ctl/AgentPages.sys.mjs) read lazily, with the members Vimma uses: LazyModules in
// types/firefox.d.ts points at them. Their downloads are FirefoxDownload (types/firefox.d.ts).

// engine/toolkit/components/downloads/DownloadPaths.sys.mjs
interface DownloadPathsModule {
  /** A leaf name safe on every platform; "" when nothing of it is left. */
  sanitize(
    leafName: string,
    options?: {
      compressWhitespaces?: boolean;
      allowInvalidFilenames?: boolean;
      allowDirectoryNames?: boolean;
    },
  ): string;
  /** A new empty file (mode 0644) beside `templateFile`, its leaf name made unique. Throws. */
  createNiceUniqueFile(templateFile: nsIFile): nsIFile;
}

// engine/toolkit/modules/Integration.sys.mjs: an integration point. An override function gets
// the combined object of those registered before it (the module's own last) and returns an
// object with the methods it overrides, the base as its prototype.
interface IntegrationPoint<T> {
  register(overrideFn: (base: T) => Partial<T>): void;
  unregister(overrideFn: (base: T) => Partial<T>): void;
  /** The module object with every override applied; `root` is the module's own. */
  getCombined(root: object): T;
}
// Integration is a Proxy: any name is a point. These are the two Vimma wraps or reads.
interface IntegrationModule {
  readonly downloads: IntegrationPoint<
    DownloadIntegrationBase & {
      /** Overrides (DownloadsViewableInternally) answer with any value; truthy is yes. */
      shouldViewDownloadInternally(mimeType: string, extension?: string): unknown;
    }
  >;
  readonly contentPermission: IntegrationPoint<ContentPermissionIntegration>;
}

// engine/toolkit/modules/subprocess/Subprocess.sys.mjs and subprocess_common.sys.mjs. Vimma
// always pipes stderr, so `stderr` is required here: without it the process has no stderr pipe.
interface SubprocessModule {
  /**
   * Starts `command` (an absolute path; PATH is not searched) with `arguments`, no shell.
   * `environment` replaces the process's own unless `environmentAppend`. Rejects when the
   * command is not an executable file.
   */
  call(options: {
    command: string;
    arguments?: readonly string[];
    environment?: Record<string, string>;
    environmentAppend?: boolean;
    workdir?: string;
    stderr: "pipe";
  }): Promise<ChildProcess>;
  /** The browser's own environment, a variable to its value. */
  getEnvironment(): Record<string, string>;
}
// A process from Subprocess.call, with stdin, stdout and stderr as pipes.
interface ChildProcess {
  readonly stdin: {
    /** Rejects when the pipe closed first; Vimma reads nothing from what it resolves to. */
    write(data: string | ArrayBuffer | ArrayBufferView): Promise<unknown>;
    close(force?: boolean): Promise<unknown>;
  };
  readonly stdout: SubprocessInputPipe;
  readonly stderr: SubprocessInputPipe;
  wait(): Promise<{ exitCode: number }>;
  /** SIGTERM, then SIGKILL after `timeout` ms (300 by default; 0 or less: SIGKILL at once). */
  kill(timeout?: number): Promise<{ exitCode: number }>;
}
interface SubprocessInputPipe {
  /** The next text read; "" at the end of the stream. */
  readString(length?: number): Promise<string>;
  close(force?: boolean): Promise<unknown>;
}

// engine/js/src/ctypes (js-ctypes, through resource://gre/modules/ctypes.sys.mjs): the types
// Vimma declares statx(2), lstat(2) and readlink(2) with (ctl/AgentDownloads.sys.mjs). A
// CType<T, I> converts its C value to T in JS (integers of 32 bits or fewer to a number, the
// 64-bit and size types to a CInt64 object), and takes an I as a function's argument.
interface CType<T, I = T> {
  /** Its size in bytes. */
  readonly size: number;
  /** A pointer takes a CData (an array decays to one) or null. */
  readonly ptr: CType<CData, CData | null>;
  array(length: number): CArrayType<T>;
  /** Type-only, never set: what an argument of this type takes (contravariant, as an input). */
  readonly __input?: (value: I) => void;
}
/** char: its pointer also takes a JS string, converted to a NUL-ended C string. */
interface CCharType extends CType<number> {
  readonly ptr: CType<CData, CData | null | string>;
}
/** What an argument of the C type `C` takes in JS. */
type CInput<C> = C extends { readonly __input?: (value: infer I) => void } ? I : never;
/** An instance of a CType: its memory. */
interface CData {
  address(): CData;
}
interface CInt64 {
  toString(radix?: number): string;
}
interface CArrayType<T> extends CType<CArray<T>, CData> {
  /** A new zeroed array. */
  (): CArray<T>;
}
interface CArray<T> extends CData {
  readonly length: number;
  readonly [index: number]: T;
}
/** A struct type's fields by name, each to its JS value. */
type CStructFields<F> = { readonly [K in keyof F]: F[K] extends CType<infer T, never> ? T : never };
interface CStructType<F> extends CType<CData & CStructFields<F>, CData> {
  /** A new zeroed struct. */
  new (): CData & CStructFields<F>;
}
/** The intersection of a union's members: a struct's one-field objects as one. */
type CUnionToIntersection<U> = (U extends unknown ? (u: U) => void : never) extends (
  i: infer I,
) => void
  ? I
  : never;
interface CLibrary {
  /** A C function of the library; its arguments convert from JS as js-ctypes converts them. */
  declare<R, const A extends readonly CType<unknown, never>[]>(
    name: string,
    abi: CABI,
    returnType: CType<R, never>,
    ...argTypes: A
  ): (...args: { [K in keyof A]: CInput<A[K]> }) => R;
  close(): void;
}
interface CABI {
  readonly __cabi: never;
}
interface CtypesModule {
  /** Opens a shared library by name or path; throws when it cannot be loaded. */
  open(name: string): CLibrary;
  /** A struct of the fields in order, one `{ name: type }` object each. */
  StructType: new <const F extends readonly Record<string, CType<unknown, never>>[]>(
    name: string,
    fields: F,
  ) => CStructType<CUnionToIntersection<F[number]>>;
  /** `data`'s memory as `type`; it must not be larger. */
  cast<T>(data: CData, type: CType<T, never>): T;
  readonly default_abi: CABI;
  readonly char: CCharType;
  readonly int: CType<number>;
  readonly unsigned_int: CType<number>;
  readonly int32_t: CType<number>;
  readonly uint8_t: CType<number>;
  readonly uint16_t: CType<number>;
  readonly uint32_t: CType<number>;
  readonly uint64_t: CType<CInt64, number | CInt64>;
  readonly size_t: CType<CInt64, number | CInt64>;
  readonly ssize_t: CType<CInt64, number | CInt64>;
}

// engine/uriloader/exthandler/nsIContentDispatchChooser.idl, as ContentDispatchChooser.sys.mjs
// implements it: asks, or launches the protocol's handler.
interface ContentDispatchChooser {
  handleURI(
    handler: unknown,
    uri: nsIURI | null,
    triggeringPrincipal: nsIPrincipal | null,
    browsingContext: BrowsingContext | null,
    wasTriggeredExternally?: boolean,
    hasValidUserGestureActivation?: boolean,
  ): void;
}

// engine/uriloader/exthandler/nsIHelperAppLauncherDialog.idl, as
// toolkit/mozapps/downloads/HelperAppDlg.sys.mjs (nsUnknownContentTypeDialog) implements it.
interface HelperAppLauncherDialog {
  show(launcher: nsIHelperAppLauncher, context: unknown, reason: number): void;
  promptForSaveToFileAsync(
    launcher: nsIHelperAppLauncher,
    context: unknown,
    defaultFileName: string,
    suggestedFileExtension: string,
    forcePrompt: boolean,
  ): void;
}
