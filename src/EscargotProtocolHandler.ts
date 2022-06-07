/*
 * Copyright 2020-present Samsung Electronics Co., Ltd. and other contributors
 * Copyright JS Foundation and other contributors, http://js.foundation
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {Breakpoint, ParsedFunction} from './EscargotBreakpoints';
import {EscargotDebuggerClient} from './EscargotDebuggerClient';
import {LOG_LEVEL} from './EscargotDebuggerConstants';
import * as SP from './EscargotProtocolConstants';
import {assembleUint16Arrays, assembleUint8Arrays, ByteConfig, createArrayFromString, createStringFromArray, decodeMessage, encodeMessage} from './EscargotUtils';
import {Source} from 'vscode-debugadapter';
import * as Path from 'path';
import * as Fs from 'fs';
import * as Crypto from 'crypto';

export type Pointer = string;
export type ByteCodeOffset = number;
export type LoggerFunction = (message: any, level: number) => void;

export interface ParserFrame {
  isFunction: boolean;
  scriptId: number;
  line: number;
  column: number;
  name: string;
  source: Array<string>;
  sourceName?: string;
  lines: Array<number>;
  offsets: Array<ByteCodeOffset>;
  byteCodePtr?: Pointer;
  firstBreakpointLine?: number;
  firstBreakpointOffset?: ByteCodeOffset;
}

export interface EscargotDebugProtocolDelegate {
  onBacktrace?(backtrace: EscargotBacktraceResult): void;
  onBreakpointHit?
      (message: EscargotMessageBreakpointHit, stopType: string): void;
  onConnected?(): void;
  onExceptionHit?(message: string): void;
  onEvalResult?(result: string): void;
  onError?(code: number, message: string): void;
  onResume?(): void;
  onScriptParsed?(message: EscargotMessageScriptParsed): void;
  onOutput?(message: string, category?: string): void;
  onWaitForSource?(): void;
  onWaitingAfterPending?(): void;
  onWaitForWaitExit?(): void;
}

export interface EscargotMessageSource {
  name: string;
  source: string;
}

export interface EscargotMessageScriptParsed {
  id: number;
  source: Source;
  breakpointsHandled: () => void;
}

export interface EscargotMessageBreakpointHit {
  breakpoint: Breakpoint;
  exact: boolean;
}

export interface EscargotEvalResult {
  subtype: number;
  value: string;
}

interface ProtocolFunctionMap {
  [type: number]: (data: Uint8Array) => void;
}

interface FunctionMap {
  [cp: string]: ParsedFunction;
}

export interface EscargotBacktraceFrame {
  function: ParsedFunction;
  line: number;
  column: number;
  depth: number;
  id: number;
}

interface ScopeNameMap {
  [type: number]: string;
}

export interface EscargotBacktraceResult {
  totalFrames: number;
  backtrace: Array<EscargotBacktraceFrame>;
}

interface StringReceiverCb {
  (data: string): any;
}

interface LineFunctionMap {
  // maps line number to an array of functions
  [line: number]: Array<ParsedFunction>;
}

interface ParsedSource {
  name?: string;
  source?: string;
  reference?: Source;
}

interface StopTypeMap {
  [type: number]: string;
}

class PendingRequest {
  public data: Uint8Array;
  public promise: Promise<any>;
  public resolve: (arg?: any) => void;
  public reject: (arg?: any) => void;

  public constructor(data: Uint8Array) {
    this.data = data;
    this.promise = new Promise<any>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class PendingEvalRequest {
  public promise: Promise<any>;
  public resolve: (arg?: any) => void;
  public reject: (arg?: any) => void;

  public constructor() {
    this.promise = new Promise<any>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

export interface EscargotEvalResult {
  subtype: number;
  value: string;
}

export interface EscargotScopeChain {
  name: string;
  scopeID: number;
  expensive: boolean;
}

export interface EscargotScopeChainElement {
  scopeIndex: number;
  stateIndex?: number;
}

export interface EscargotScopeVariable {
  name: string;
  type: string;
  value: string;
  fullType: number;
  hasValue: boolean;
  objectIndex: number;
}

// abstracts away the details of the protocol
export class EscargotDebugProtocolHandler {
  public debuggerClient?: EscargotDebuggerClient;
  private delegate: EscargotDebugProtocolDelegate;

  // debugger configuration
  private byteConfig: ByteConfig;
  private version: number = 0;
  private functionMap: ProtocolFunctionMap;
  private scopeNameMap: ScopeNameMap;
  private localRoot: string;

  // first element is a dummy because sources is 1-indexed
  private sources: Array<ParsedSource> = [{}];
  // first element is a dummy because lineLists is 1-indexed
  private lineLists: Array<LineFunctionMap> = [[]];
  private source: string = '';
  private stringBuffer: Uint8Array;
  private stringBuffer16: Uint16Array;
  private stringReceiverMessage: number;
  private stringReceivedCb: StringReceiverCb;
  private sourceName?: string;
  private functionName?: string;
  private lines: Array<number> = [];
  private offsets: Array<ByteCodeOffset> = [];
  private isFunction: boolean = false;
  private functions: FunctionMap = {};
  private newFunctions: FunctionMap = {};
  private breakpointsInserted: Promise<void>;
  private backtraceData:
      EscargotBacktraceResult = {totalFrames: 0, backtrace: []};
  private backtraceFrames: Map<number, number>;
  private scopeList: Map<number, EscargotScopeChainElement>;
  private backtraceFrameID: number = 0;
  private scopeID: number = 1000;
  private waitForSourceEnabled: boolean = false;
  private waitBeforeExit: boolean = false;
  private terminateException: boolean = false;

  private maxMessageSize: number = 0;
  private nextScriptID: number = 1;
  private evalsPending: Array<PendingEvalRequest> = [];
  private lastBreakpointHit?: Breakpoint;
  private activeBreakpoints: Array<Breakpoint> = [];
  private nextBreakpointIndex: number = 0;
  private scopeVariables: Array<EscargotScopeVariable> = [];
  private currentScopeVariable: EscargotScopeVariable;
  private currentScopeChain: Array<EscargotScopeChain> = [];

  private log: LoggerFunction;
  private requestQueue: PendingRequest[];
  private currentRequest: PendingRequest;
  private stopTypeMap: StopTypeMap;
  private lastStopType: number;

  constructor(delegate: EscargotDebugProtocolDelegate, localRoot: string, log?: LoggerFunction) {
    this.delegate = delegate;
    this.localRoot = localRoot;
    this.log = log || <any>(() => {});
    this.backtraceFrames = new Map<number, number>();
    this.scopeList = new Map<number, EscargotScopeChainElement>();

    this.byteConfig = {
      pointerSize: 0,
      littleEndian: true,
    };

    this.functionMap = {
      [SP.SERVER.ESCARGOT_DEBUGGER_VERSION]: this.onVersion,
      [SP.SERVER.ESCARGOT_DEBUGGER_CONFIGURATION]: this.onConfiguration,
      [SP.SERVER.ESCARGOT_DEBUGGER_CLOSE_CONNECTION]: this.onCloseConnection,
      [SP.SERVER.ESCARGOT_DEBUGGER_RELEASE_FUNCTION]: this.onReleaseFunctionPtr,
      [SP.SERVER.ESCARGOT_DEBUGGER_PARSE_NODE]: this.onParseDone,
      [SP.SERVER.ESCARGOT_DEBUGGER_PARSE_ERROR]: this.onParseError,

      [SP.SERVER.ESCARGOT_DEBUGGER_SOURCE_8BIT]: this.onSourceCode,
      [SP.SERVER.ESCARGOT_DEBUGGER_SOURCE_8BIT_END]: this.onSourceCode,
      [SP.SERVER.ESCARGOT_DEBUGGER_SOURCE_16BIT]: this.onSourceCode,
      [SP.SERVER.ESCARGOT_DEBUGGER_SOURCE_16BIT_END]: this.onSourceCode,

      [SP.SERVER.ESCARGOT_DEBUGGER_FILE_NAME_8BIT]: this.onFileName,
      [SP.SERVER.ESCARGOT_DEBUGGER_FILE_NAME_8BIT_END]: this.onFileName,
      [SP.SERVER.ESCARGOT_DEBUGGER_FILE_NAME_16BIT]: this.onFileName,
      [SP.SERVER.ESCARGOT_DEBUGGER_FILE_NAME_16BIT_END]: this.onFileName,

      [SP.SERVER.ESCARGOT_DEBUGGER_FUNCTION_NAME_8BIT]: this.onFunctionName,
      [SP.SERVER.ESCARGOT_DEBUGGER_FUNCTION_NAME_8BIT_END]: this.onFunctionName,
      [SP.SERVER.ESCARGOT_DEBUGGER_FUNCTION_NAME_16BIT]: this.onFunctionName,
      [SP.SERVER.ESCARGOT_DEBUGGER_FUNCTION_NAME_16BIT_END]:
          this.onFunctionName,

      [SP.SERVER.ESCARGOT_DEBUGGER_BREAKPOINT_LOCATION]: this.onBreakpointList,
      [SP.SERVER.ESCARGOT_DEBUGGER_FUNCTION_PTR]: this.onFunctionPtr,
      [SP.SERVER.ESCARGOT_DEBUGGER_BREAKPOINT_HIT]: this.onBreakpointHit,
      [SP.SERVER.ESCARGOT_DEBUGGER_EXCEPTION_HIT]: this.onBreakpointHit,

      [SP.SERVER.ESCARGOT_DEBUGGER_EVAL_RESULT_8BIT]: this.onEvalResult,
      [SP.SERVER.ESCARGOT_DEBUGGER_EVAL_RESULT_8BIT_END]: this.onEvalResult,
      [SP.SERVER.ESCARGOT_DEBUGGER_EVAL_RESULT_16BIT]: this.onEvalResult,
      [SP.SERVER.ESCARGOT_DEBUGGER_EVAL_RESULT_16BIT_END]: this.onEvalResult,

      [SP.SERVER.ESCARGOT_DEBUGGER_EVAL_FAILED_8BIT]: this.onEvalFailed,
      [SP.SERVER.ESCARGOT_DEBUGGER_EVAL_FAILED_8BIT_END]: this.onEvalFailed,
      [SP.SERVER.ESCARGOT_DEBUGGER_EVAL_FAILED_16BIT]: this.onEvalFailed,
      [SP.SERVER.ESCARGOT_DEBUGGER_EVAL_FAILED_16BIT_END]: this.onEvalFailed,

      [SP.SERVER.ESCARGOT_DEBUGGER_BACKTRACE_TOTAL]: this.onBacktraceTotal,
      [SP.SERVER.ESCARGOT_DEBUGGER_BACKTRACE]: this.onBacktrace,
      [SP.SERVER.ESCARGOT_DEBUGGER_BACKTRACE_END]: this.onBacktraceEnd,

      [SP.SERVER.ESCARGOT_DEBUGGER_SCOPE_CHAIN]: this.onScopeChain,
      [SP.SERVER.ESCARGOT_DEBUGGER_SCOPE_CHAIN_END]: this.onScopeChainEnd,
      [SP.SERVER.ESCARGOT_DEBUGGER_MESSAGE_VARIABLE]: this.onScopeVariable,

      [SP.SERVER.ESCARGOT_DEBUGGER_STRING_8BIT]: this.onMessageString,
      [SP.SERVER.ESCARGOT_DEBUGGER_STRING_8BIT_END]: this.onMessageString,
      [SP.SERVER.ESCARGOT_DEBUGGER_STRING_16BIT]: this.onMessageString,
      [SP.SERVER.ESCARGOT_DEBUGGER_STRING_16BIT_END]: this.onMessageString,
      [SP.SERVER.ESCARGOT_DEBUGGER_MESSAGE_PRINT]: this.onPrint,
      [SP.SERVER.ESCARGOT_DEBUGGER_MESSAGE_EXCEPTION]: this.onException,
      [SP.SERVER.ESCARGOT_DEBUGGER_MESSAGE_EXCEPTION_BACKTRACE]:
          this.onBacktrace,
      [SP.SERVER.ESCARGOT_DEBUGGER_WAIT_FOR_SOURCE]: this.onWaitForSource,
      [SP.SERVER.ESCARGOT_DEBUGGER_WAITING_AFTER_PENDING]:
          this.onWaitingAfterPending,
      [SP.SERVER.ESCARGOT_DEBUGGER_WAIT_FOR_WAIT_EXIT]: this.onWaitForWaitExit,
    };

    this.scopeNameMap = {
      [SP.ESCARGOT_DEBUGGER_SCOPE_TYPE.ESCARGOT_DEBUGGER_SCOPE_GLOBAL]:
          'Global Environment',
      [SP.ESCARGOT_DEBUGGER_SCOPE_TYPE.ESCARGOT_DEBUGGER_SCOPE_FUNCTION]:
          'Function Environment',
      [SP.ESCARGOT_DEBUGGER_SCOPE_TYPE.ESCARGOT_DEBUGGER_SCOPE_DECLARATIVE]:
          'Declarative Environment',
      [SP.ESCARGOT_DEBUGGER_SCOPE_TYPE.ESCARGOT_DEBUGGER_SCOPE_OBJECT]:
          'Object Environment',
      [SP.ESCARGOT_DEBUGGER_SCOPE_TYPE.ESCARGOT_DEBUGGER_SCOPE_MODULE]:
          'Module Environment',
      [SP.ESCARGOT_DEBUGGER_SCOPE_TYPE.ESCARGOT_DEBUGGER_SCOPE_UNKNOWN]:
          'Unknown Environment',
    };

    this.requestQueue = [];
    this.currentRequest = null;

    this.stopTypeMap = {
      [SP.CLIENT.ESCARGOT_DEBUGGER_NEXT]: 'step',
      [SP.CLIENT.ESCARGOT_DEBUGGER_STEP]: 'step-in',
      [SP.CLIENT.ESCARGOT_DEBUGGER_FINISH]: 'step-out',
      [SP.CLIENT.ESCARGOT_DEBUGGER_CONTINUE]: 'continue',
      [SP.CLIENT.ESCARGOT_DEBUGGER_STOP]: 'pause',
    };
    this.lastStopType = null;
  }

  public stepOver(): Promise<any> {
    return this.resumeExec(SP.CLIENT.ESCARGOT_DEBUGGER_NEXT);
  }

  public stepInto(): Promise<any> {
    return this.resumeExec(SP.CLIENT.ESCARGOT_DEBUGGER_STEP);
  }

  public stepOut(): Promise<any> {
    return this.resumeExec(SP.CLIENT.ESCARGOT_DEBUGGER_FINISH);
  }

  public pause(): Promise<any> {
    if (this.lastBreakpointHit) {
      return Promise.reject(new Error('attempted pause while at breakpoint'));
    }

    this.lastStopType = SP.CLIENT.ESCARGOT_DEBUGGER_STOP;
    return this.sendSimpleRequest(encodeMessage(
        this.byteConfig, 'B', [SP.CLIENT.ESCARGOT_DEBUGGER_STEP]));
  }

  public resume(): Promise<any> {
    return this.resumeExec(SP.CLIENT.ESCARGOT_DEBUGGER_CONTINUE);
  }

  public getAllLineBreakpoints(
      scriptId: number, line: number): Array<Breakpoint> {
    const array = [];
    const funcList = this.lineLists[scriptId][line];

    if (funcList) {
      for (const func of funcList) {
        array.push(func.lines[line]);
      }
    }

    return array;
  }

  public getSources(): ParsedSource[] {
    // The first element is a dummy because sources is 1-indexed
    return this.sources.slice(1);
  }

  public getSource(scriptId: number): string {
    if (scriptId < this.sources.length) {
      return this.sources[scriptId].source || '';
    }
    return '';
  }

  public getReference(scriptId: number): Source {
    if (scriptId < this.sources.length) {
      return this.sources[scriptId].reference;
    }
    return new Source('');
  }

  private decodeMessage(format: string, message: Uint8Array, offset: number):
      any {
    return decodeMessage(this.byteConfig, format, message, offset);
  }

  public onVersion(data: Uint8Array): void {
    this.logPacket('Version');
    if (data.length !== 6) {
      this.abort('version message wrong size');
      return;
    }

    this.byteConfig.littleEndian = Boolean(data[1]);
    this.version = this.decodeMessage('I', data, 2)[0];

    if (this.version !== SP.ESCARGOT_DEBUGGER_VERSION) {
      this.abort(`incorrect target debugger version detected: ${this.version}
                  expected: ${SP.ESCARGOT_DEBUGGER_VERSION}`);
    }
  }

  public onConfiguration(data: Uint8Array): void {
    this.logPacket('Configuration');
    if (data.length !== 3) {
      this.abort('configuration message wrong size');
      return;
    }

    this.maxMessageSize = data[1];
    this.byteConfig.pointerSize = data[2];

    if (this.byteConfig.pointerSize !== 4 &&
        this.byteConfig.pointerSize !== 8) {
      this.abort(`unsupported pointer size: ${this.byteConfig.pointerSize}`);
    }

    this.sendSimpleRequest(encodeMessage(
      this.byteConfig, 'BB', [SP.CLIENT.ESCARGOT_DEBUGGER_PENDING_CONFIG, 1]));

    if (this.delegate.onConnected) {
      this.delegate.onConnected();
    }
  }

  public onFunctionPtr(data: Uint8Array): void {
    this.logPacket('Function Ptr', true);

    const decoded = this.decodeMessage('CII', data, 1);

    const frame = <ParserFrame>{
      isFunction: this.isFunction,
      scriptId: this.nextScriptID,
      line: decoded[1],
      column: decoded[2],
      name: this.functionName,
      source: this.source.split(/\n/),
      sourceName: this.sourceName,
      lines: this.lines,
      offsets: this.offsets,
    };

    const func = new ParsedFunction(decoded[0], frame);
    this.newFunctions[decoded[0]] = func;

    this.lines = [];
    this.offsets = [];
  }

  private onParseErrorEnd(str: string): void {
    if (this.delegate.onOutput) {
      this.delegate.onOutput(`Exception: ${str}`, 'stderr');
    }
  }

  private onParseError(data: Uint8Array): void {
    this.log('Parse error detected', LOG_LEVEL.ERROR);

    this.stringReceiverMessage = SP.SERVER.ESCARGOT_DEBUGGER_STRING_8BIT;
    this.stringReceivedCb = this.onParseErrorEnd;
    this.receiveString(data);
  }

  private onParseDone(data: Uint8Array): void {
    this.logPacket('Parse Done');

    const lineList: LineFunctionMap = {};
    for (const p in this.newFunctions) {
      const func = this.newFunctions[p];
      this.functions[p] = func;

      for (const i in func.lines) {
        // map line numbers to functions for this source
        if (i in lineList) {
          lineList[i].push(func);
        } else {
          lineList[i] = [func];
        }
      }
    }

    let breakpointsHandled: () => void;

    this.lineLists.push(lineList);
    this.newFunctions = {};
    this.breakpointsInserted = new Promise<void>(resolve => { breakpointsHandled = resolve });

    if (this.delegate.onScriptParsed) {
      this.delegate.onScriptParsed({
        id: this.nextScriptID,
        source: this.sources[this.nextScriptID].reference,
        breakpointsHandled
      });
    }

    this.nextScriptID++;
  }

  public onBreakpointList(data: Uint8Array): void {
    this.logPacket('Breakpoint List', true);

    if (data.byteLength % 8 !== 1 || data.byteLength < 1 + 8) {
      throw new Error('unexpected breakpoint list message length');
    }

    for (let i = 1; i < data.byteLength; i += 8) {
      let decoded = this.decodeMessage('II', data, i);
      this.lines.push(decoded[0]);
      this.offsets.push(decoded[1]);
    }
  }

  public receiveString(data: Uint8Array): any {
    const is8bit = (data[0] - this.stringReceiverMessage) < 2;
    const isEnd = ((data[0] - this.stringReceiverMessage) & 0x01) === 1;

    if (is8bit) {
      this.stringBuffer = assembleUint8Arrays(this.stringBuffer, data);
    } else {
      this.stringBuffer16 =
          assembleUint16Arrays(this.byteConfig, this.stringBuffer16, data);
    }

    if (isEnd) {
      const str = createStringFromArray(
          is8bit ? this.stringBuffer : this.stringBuffer16);
      this.stringReceiverMessage = NaN;
      this.stringBuffer = undefined;
      this.stringBuffer16 = undefined;
      const currentStringReceiveCb = this.stringReceivedCb;
      const result = this.stringReceivedCb(str);
      if (currentStringReceiveCb === this.stringReceivedCb) {
        this.stringReceivedCb = null;
      }
      return result;
    }
  }

  private onSourceCodeEnd(str: string): void {
    this.source = str;
    this.functionName = 'global';
    this.isFunction = false;
  }

  public onSourceCode(data: Uint8Array): void {
    this.logPacket(`Source Code`, true);

    this.stringReceiverMessage = SP.SERVER.ESCARGOT_DEBUGGER_SOURCE_8BIT;
    this.stringReceivedCb = this.onSourceCodeEnd;
    this.receiveString(data);
  }

  private onFileNameEnd(str: string): void {
    let path = str;
    let sourceReference = this.nextScriptID;

    if (str === 'eval code' || str.length == 0) {
      str = `eval_${str.length}_${Crypto.createHash('md5').update(this.source).digest('hex')}.js`;
      path = str;
    } else {
      if (str[0] != '/') {
        path = Path.join(this.localRoot, str);
      }

      try {
        if (Fs.readFileSync(path, {encoding: 'utf8', flag: 'r'}) === this.source) {
          /* File matches to a real file. */
          sourceReference = 0;
        }
      } catch {
        /* Ignore all errors. */
      }
    }

    this.sourceName = str;
    this.sources[this.nextScriptID] = {
      name: str,
      source: this.source,
      reference: new Source(Path.basename(str), path, sourceReference),
    };
  }

  public onFileName(data: Uint8Array): void {
    this.logPacket('File Name', true);

    this.stringReceiverMessage = SP.SERVER.ESCARGOT_DEBUGGER_FILE_NAME_8BIT;
    this.stringReceivedCb = this.onFileNameEnd;
    this.receiveString(data);
  }

  private onFunctionNameEnd(str: string): void {
    this.functionName = str;
    this.isFunction = true;
  }

  private onFunctionName(data: Uint8Array): void {
    this.logPacket('Function Name');

    this.stringReceiverMessage = SP.SERVER.ESCARGOT_DEBUGGER_FUNCTION_NAME_8BIT;
    this.stringReceivedCb = this.onFunctionNameEnd;
    this.receiveString(data);
  }

  public releaseFunction(functionPtr: Pointer): void {
    const func = this.functions[functionPtr];

    if (!func) {
      return;
    }

    const lineList = this.lineLists[func.scriptId];
    for (const i in func.lines) {
      const array = lineList[i];
      const index = array.indexOf(func);
      array.splice(index, 1);

      const breakpoint = func.lines[i];
      if (breakpoint.activeIndex >= 0) {
        delete this.activeBreakpoints[breakpoint.activeIndex];
      }
    }

    delete this.functions[functionPtr];
  }

  private onReleaseFunctionPtr(data: Uint8Array): void {
    this.logPacket('Release Function Pointer', true);
    if (!this.evalsPending.length) {
      const functionPtr = this.decodeMessage('C', data, 1)[0];
      if (functionPtr in this.newFunctions) {
        delete this.newFunctions[functionPtr];
      } else {
        this.releaseFunction(functionPtr);
      }
    }

    // just patch up incoming message
    data[0] = SP.CLIENT.ESCARGOT_DEBUGGER_FUNCTION_RELEASED;
    this.sendSimpleRequest(data);
  }

  private getBreakpoint(breakpointData: Array<number>):
      EscargotMessageBreakpointHit {
    const func = this.functions[breakpointData[0]];
    const offset = breakpointData[1];

    if (offset in func.offsets) {
      return {
        breakpoint: func.offsets[offset],
        exact: true,
      };
    }

    if (offset < func.firstBreakpointOffset) {
      return {
        breakpoint: func.offsets[func.firstBreakpointOffset],
        exact: true,
      };
    }

    let nearestOffset = -1;
    for (const currentOffset in func.offsets) {
      const current = Number(currentOffset);
      if ((current <= offset) && (current > nearestOffset)) {
        nearestOffset = current;
      }
    }

    return {
      breakpoint: func.offsets[nearestOffset],
      exact: false,
    };
  }

  public onBreakpointHit(data: Uint8Array): void {
    this.logPacket('Breakpoint Hit');

    const breakpointData = this.decodeMessage('CI', data, 1);
    const breakpointRef = this.getBreakpoint(breakpointData);
    const breakpoint = breakpointRef.breakpoint;

    this.lastBreakpointHit = breakpoint;

    let breakpointInfo = '';
    if (breakpoint.activeIndex >= 0) {
      breakpointInfo = `breakpoint:${breakpoint.activeIndex} `;
    }

    const atAround = breakpointRef.exact ? 'at' : 'around';
    this.log(
        `Stopped ${atAround} ${breakpointInfo}${breakpoint}`,
        LOG_LEVEL.PROTOCOL);

    if (this.delegate.onBreakpointHit) {
      const stopTypeText = this.stopTypeMap[this.lastStopType] || 'entry';
      const stopType =
          `${breakpoint.activeIndex === -1 ? 'inactive ' : ''}breakpoint (${
              stopTypeText})`;
      this.delegate.onBreakpointHit(breakpointRef, stopType);
    }

    this.lastStopType = null;
  }

  public processScopeChainElement(data: Uint8Array): void {
    for (let i = 1; i < data.byteLength; i++) {
      if (data[i] >
          SP.ESCARGOT_DEBUGGER_SCOPE_TYPE.ESCARGOT_DEBUGGER_SCOPE_UNKNOWN) {
        throw new Error('Invalid scope chain type!');
      }

      this.scopeList.set(this.scopeID, {scopeIndex: i - 1});
      const expensive: boolean = data[i] ===
          SP.ESCARGOT_DEBUGGER_SCOPE_TYPE.ESCARGOT_DEBUGGER_SCOPE_GLOBAL;
      this.currentScopeChain.push({
        name: this.scopeNameMap[data[i]],
        scopeID: this.scopeID++,
        expensive
      });
    }
  }

  public onScopeChain(data: Uint8Array): void {
    this.logPacket('ScopeChain');

    this.processScopeChainElement(data);
  }

  public onScopeChainEnd(data: Uint8Array): Array<EscargotScopeChain> {
    this.logPacket('ScopeChainEnd');

    this.processScopeChainElement(data);
    const scopeChain = this.currentScopeChain;
    this.currentScopeChain = [];

    return scopeChain;
  }

  public onScopeVariableValue(str: string) {
    this.logPacket('ScopeVariable Value');
    if (this.currentScopeVariable.fullType &
        SP.ESCARGOT_DEBUGGER_SCOPE_VARIABLES
            .ESCARGOT_DEBUGGER_VARIABLE_LONG_VALUE) {
      this.currentScopeVariable.value += '...';
    }

    this.currentScopeVariable.value = str;
    this.scopeVariables.push(this.currentScopeVariable);
  }

  public onScopeVariableName(str: string) {
    this.logPacket('ScopeVariable Name');
    this.currentScopeVariable.name = str;
    if (this.currentScopeVariable.fullType &
        SP.ESCARGOT_DEBUGGER_SCOPE_VARIABLES
            .ESCARGOT_DEBUGGER_VARIABLE_LONG_NAME) {
      this.currentScopeVariable.name += '...';
    }

    if (!this.currentScopeVariable.hasValue) {
      this.scopeVariables.push(this.currentScopeVariable);
    } else {
      this.stringReceivedCb = this.onScopeVariableValue;
    }
  }

  public onScopeVariable(data: Uint8Array): any {
    this.logPacket('ScopeVariables');

    this.currentScopeVariable = {
      name: '',
      type: '',
      value: '',
      fullType: data[1],
      hasValue: false,
      objectIndex: -1
    };

    let variableType = this.currentScopeVariable.fullType & 0x3f;

    switch (variableType) {
      case SP.ESCARGOT_DEBUGGER_SCOPE_VARIABLES
          .ESCARGOT_DEBUGGER_VARIABLE_END: {
        let scopeVariables = this.scopeVariables;
        this.scopeVariables = [];
        return scopeVariables;
      }
      case SP.ESCARGOT_DEBUGGER_SCOPE_VARIABLES
          .ESCARGOT_DEBUGGER_VARIABLE_UNACCESSIBLE: {
        this.currentScopeVariable.type = 'unaccessible';
        break;
      }
      case SP.ESCARGOT_DEBUGGER_SCOPE_VARIABLES
          .ESCARGOT_DEBUGGER_VARIABLE_UNDEFINED: {
        this.currentScopeVariable.type = 'undefined';
        break;
      }
      case SP.ESCARGOT_DEBUGGER_SCOPE_VARIABLES
          .ESCARGOT_DEBUGGER_VARIABLE_NULL: {
        this.currentScopeVariable.type = 'null';
        break;
      }
      case SP.ESCARGOT_DEBUGGER_SCOPE_VARIABLES
          .ESCARGOT_DEBUGGER_VARIABLE_TRUE: {
        this.currentScopeVariable.type = 'true';
        break;
      }
      case SP.ESCARGOT_DEBUGGER_SCOPE_VARIABLES
          .ESCARGOT_DEBUGGER_VARIABLE_FALSE: {
        this.currentScopeVariable.type = 'false';
        break;
      }
      case SP.ESCARGOT_DEBUGGER_SCOPE_VARIABLES
          .ESCARGOT_DEBUGGER_VARIABLE_NUMBER: {
        this.currentScopeVariable.type = 'number';
        this.currentScopeVariable.hasValue = true;
        break;
      }
      case SP.ESCARGOT_DEBUGGER_SCOPE_VARIABLES
          .ESCARGOT_DEBUGGER_VARIABLE_STRING: {
        this.currentScopeVariable.type = 'string';
        this.currentScopeVariable.hasValue = true;
        break;
      }
      case SP.ESCARGOT_DEBUGGER_SCOPE_VARIABLES
          .ESCARGOT_DEBUGGER_VARIABLE_SYMBOL: {
        this.currentScopeVariable.type = 'Symbol:';
        this.currentScopeVariable.hasValue = true;
        break;
      }
      case SP.ESCARGOT_DEBUGGER_SCOPE_VARIABLES
          .ESCARGOT_DEBUGGER_VARIABLE_BIGINT: {
        this.currentScopeVariable.type = 'bigint';
        this.currentScopeVariable.hasValue = true;
        break;
      }
      case SP.ESCARGOT_DEBUGGER_SCOPE_VARIABLES
          .ESCARGOT_DEBUGGER_VARIABLE_OBJECT: {
        this.currentScopeVariable.type = 'object';
        this.currentScopeVariable.objectIndex =
            this.decodeMessage('I', data, 2)[0];
        break;
      }
      case SP.ESCARGOT_DEBUGGER_SCOPE_VARIABLES
          .ESCARGOT_DEBUGGER_VARIABLE_ARRAY: {
        this.currentScopeVariable.type = 'array';
        this.currentScopeVariable.objectIndex =
            this.decodeMessage('I', data, 2)[0];
        break;
      }
      case SP.ESCARGOT_DEBUGGER_SCOPE_VARIABLES
          .ESCARGOT_DEBUGGER_VARIABLE_FUNCTION: {
        this.currentScopeVariable.type = 'function';
        this.currentScopeVariable.objectIndex =
            this.decodeMessage('I', data, 2)[0];
        break;
      }
      default: {
        throw Error('Invalid scope variable type');
      }
    }

    this.stringReceivedCb = this.onScopeVariableName;
  }

  public onPrintEnd(str: string): void {
    if (this.delegate.onOutput) {
      this.delegate.onOutput(str);
    }
  }

  public onPrint(data: Uint8Array): void {
    this.logPacket('Print');
    this.stringReceivedCb = this.onPrintEnd;
  }

  public onExceptionEnd(str: string): void {
    if (this.delegate.onOutput) {
      this.delegate.onOutput(`Exception: ${str}`, 'stderr');
    }

    this.log('Exception throw detected', LOG_LEVEL.ERROR);
    this.log(`Exception hint: ${str}`, LOG_LEVEL.ERROR);

    if (this.delegate.onExceptionHit) {
      this.delegate.onExceptionHit(str);
    }

    this.terminateException = true;
  }

  public onException(data: Uint8Array): void {
    this.logPacket('Exception');
    this.stringReceivedCb = this.onExceptionEnd;
  }

  public onMessageStringEnd(str: string): void {
    this.abort('Uncaught message string!');
  }

  public onMessageString(data: Uint8Array): void {
    this.logPacket('Message string');

    this.stringReceiverMessage = SP.SERVER.ESCARGOT_DEBUGGER_STRING_8BIT;
    if (!this.stringReceivedCb) {
      this.abort('Uncaught message string!');
    }
    this.receiveString(data);
  }

  public onBacktraceTotal(data: Uint8Array): void {
    this.logPacket('Backtrace Total');

    this.backtraceData.totalFrames = this.decodeMessage('I', data, 1);
    this.backtraceData.backtrace = [];
  }

  private decodeBackTraceFrame(data: Uint8Array): void {
    for (let i = 1; i < data.byteLength;
         i += this.byteConfig.pointerSize + 12) {
      const backtraceData = this.decodeMessage('CIII', data, i);
      let frame = <EscargotBacktraceFrame>{
        function: this.functions[backtraceData[0]],
        line: backtraceData[1],
        column: backtraceData[2],
        id: this.backtraceFrameID++,
      };
      this.backtraceData.backtrace.push(frame);
      this.backtraceFrames.set(frame.id, backtraceData[3]);
    }
  }

  public resolveBacktraceFrameDepthByID(id: number): number {
    return this.backtraceFrames.get(id);
  }

  public resolveScopeChainElementByID(id: number): EscargotScopeChainElement {
    return this.scopeList.get(id);
  }

  public addScopeVariableObject(objectID: number): number {
    let id = this.scopeID++;
    this.scopeList.set(id, {stateIndex: -1, scopeIndex: objectID});
    return id;
  }

  public setScopeChainElementState(id: number, stateIndex: number) {
    return this.scopeList.get(id).stateIndex = stateIndex;
  }

  public onBacktraceEnd(data: Uint8Array): EscargotBacktraceResult {
    this.logPacket('Backtrace End');
    this.decodeBackTraceFrame(data);

    if (this.delegate.onBacktrace) {
      this.delegate.onBacktrace(this.backtraceData);
    }

    return this.backtraceData;
  }

  public onBacktrace(data: Uint8Array): void {
    this.logPacket('Backtrace');
    this.decodeBackTraceFrame(data);
  }

  public onEvalFailedEnd(str: string): string {
    if (this.delegate.onEvalResult) {
      this.delegate.onEvalResult(str);
    }

    const resultValue = `Exception: ${str}`;
    this.evalsPending.shift().resolve(resultValue)
    return resultValue;
  }

  public onEvalFailed(data: Uint8Array): void {
    this.logPacket('Eval Failed');

    this.stringReceiverMessage = SP.SERVER.ESCARGOT_DEBUGGER_EVAL_FAILED_8BIT;
    this.stringReceivedCb = this.onEvalFailedEnd;
    return this.receiveString(data);
  }

  public onEvalResultEnd(str: string): string {
    if (this.delegate.onEvalResult) {
      this.delegate.onEvalResult(str);
    }

    this.evalsPending.shift().resolve(str)
    return str;
  }

  public onEvalResult(data: Uint8Array): void {
    this.logPacket('Eval Result');

    this.stringReceiverMessage = SP.SERVER.ESCARGOT_DEBUGGER_EVAL_RESULT_8BIT;
    this.stringReceivedCb = this.onEvalResultEnd;
    return this.receiveString(data);
  }

  public onWaitingAfterPending(data: Uint8Array): void {
    this.logPacket('onWaitingAfterPending');

    this.breakpointsInserted.then(() => {
      this.sendSimpleRequest(encodeMessage(
         this.byteConfig, 'B', [SP.CLIENT.ESCARGOT_DEBUGGER_PENDING_RESUME]));
    });
  }

  public onMessage(message: Uint8Array): void {
    if (message.byteLength < 1) {
      this.abort('message too short');
      return;
    }

    if (this.version === 0) {
      if (message[0] !== SP.SERVER.ESCARGOT_DEBUGGER_VERSION) {
        this.abort('the first message must be configuration');
        return;
      }
    }

    const request = this.currentRequest;
    let handler = this.functionMap[message[0]];

    if (!isNaN(this.stringReceiverMessage)) {
      handler = this.receiveString;
    }

    if (handler) {
      const result = handler.call(this, message) || false;
      if (request && result) {
        request.resolve(result);

        // Process the queued requests.
        if (this.requestQueue.length > 0) {
          const newRequest = this.requestQueue.shift();

          if (!this.submitRequest(newRequest)) {
            newRequest.reject('Failed to submit request.');
          }
        } else {
          this.currentRequest = null;
        }
      }
    } else {
      if (request)
        request.reject(`unhandled protocol message type: ${message[0]}`);
      this.abort(`unhandled protocol message type: ${message[0]}`);
    }
  }
  public onCloseConnection(): void {
    this.logPacket('Close connection');

    this.debuggerClient.disconnect();
  }

  public getLastBreakpoint(): Breakpoint {
    return this.lastBreakpointHit;
  }

  public getScriptIdByPath(path: string): number {
    const index = this.sources.findIndex(s => s.reference && s.reference.path === path);
    if (index > 0)
      return index;
    throw new Error(`Source '${path}' has not parsed yet`);
  }

  public getActiveBreakpoint(breakpointId: number): Breakpoint {
    return this.activeBreakpoints[breakpointId];
  }

  public findBreakpoint(scriptId: number, line: number, column: number = 0):
      Breakpoint {
    if (scriptId <= 0 || scriptId >= this.sources.length) {
      throw new Error('invalid script id');
    }

    const lineList = this.lineLists[scriptId];
    if (!lineList[line]) {
      throw new Error(`no breakpoint found for line: ${line}`);
    }

    for (const func of lineList[line]) {
      const breakpoint = func.lines[line];
      // TODO: when we start handling columns we would need to distinguish them
      return breakpoint;
    }

    throw new Error('no breakpoint found');
  }

  public updateBreakpoint(breakpoint: Breakpoint, enable: boolean):
      Promise<void> {
    let breakpointId;

    if (enable) {
      if (breakpoint.activeIndex !== -1) {
        return Promise.reject(new Error('breakpoint already enabled'));
      }
      breakpointId = breakpoint.activeIndex = this.nextBreakpointIndex++;
      this.activeBreakpoints[breakpointId] = breakpoint;
    } else {
      if (breakpoint.activeIndex === -1) {
        return Promise.reject(new Error('breakpoint already disabled'));
      }
      breakpointId = breakpoint.activeIndex;
      delete this.activeBreakpoints[breakpointId];
      breakpoint.activeIndex = -1;
    }

    return this.sendSimpleRequest(encodeMessage(this.byteConfig, 'BBCI', [
      SP.CLIENT.ESCARGOT_DEBUGGER_UPDATE_BREAKPOINT,
      Number(enable),
      breakpoint.func.functionPtr,
      breakpoint.offset,
    ]));
  }

  public sendString(messageType: number, str: string, simple: boolean = false) {
    const requestSendCb = simple ? this.sendSimpleRequest : this.sendRequest;

    const array = createArrayFromString(this.byteConfig, str);

    const size = array.length;
    let messageHeader = 1 + 4;

    if (array.some(x => x > 0xff)) {
      messageType += 2;
    }

    let maxFragment = Math.min(this.maxMessageSize - messageHeader, size);

    let message = encodeMessage(this.byteConfig, 'BI', [messageType, size]);

    if (size === maxFragment) {
      return requestSendCb.call(this, Uint8Array.from([...message, ...array]));
    }

    let request = requestSendCb.call(
        this, Uint8Array.from([...message, ...array.slice(0, maxFragment)]));
    let offset = maxFragment;
    messageHeader = 1;
    messageType += 1;

    maxFragment = this.maxMessageSize - messageHeader;

    while (offset < size) {
      let nextFragment = Math.min(maxFragment, size - offset);

      message = encodeMessage(this.byteConfig, 'B', [messageType]);

      let prevOffset = offset;
      offset += nextFragment;

      request = requestSendCb.call(
          this,
          Uint8Array.from([...message, ...array.slice(prevOffset, offset)]));
    }

    return request;
  }

  public async evaluate(expression: string, index: number): Promise<any> {
    let request = new PendingEvalRequest();
    this.evalsPending.push(request);

    await this.sendString(
        this.lastBreakpointHit ?
            SP.CLIENT.ESCARGOT_DEBUGGER_EVAL_8BIT_START :
            SP.CLIENT.ESCARGOT_DEBUGGER_EVAL_WITHOUT_STOP_8BIT_START,
        expression, true);

    return request.promise;
  }

  public requestScopes(depth: number): Promise<any> {
    if (!this.lastBreakpointHit) {
      return Promise.reject(
          new Error('scope chain not allowed while app running'));
    }

    return this.sendRequest(encodeMessage(
        this.byteConfig, 'BI',
        [SP.CLIENT.ESCARGOT_DEBUGGER_GET_SCOPE_CHAIN, depth]));
  }

  public requestScopeVariables(stateIndex: number, scopeIndex: number):
      Promise<any> {
    if (!this.lastBreakpointHit) {
      return Promise.reject(
          new Error('scope variables not allowed while app running'));
    }

    return this.sendRequest(encodeMessage(this.byteConfig, 'BII', [
      SP.CLIENT.ESCARGOT_DEBUGGER_GET_SCOPE_VARIABLES, stateIndex, scopeIndex
    ]));
  }

  public requestObjectVariables(objectIndex: number): Promise<any> {
    if (!this.lastBreakpointHit) {
      return Promise.reject(
          new Error('scope variables not allowed while app running'));
    }

    return this.sendRequest(encodeMessage(
        this.byteConfig, 'BI',
        [SP.CLIENT.ESCARGOT_DEBUGGER_GET_OBJECT, objectIndex]));
  }

  public requestBacktrace(start?: number, levels?: number): Promise<any> {
    if (start === undefined)
      start = 0;
    if (levels === undefined)
      levels = 0;

    if (this.terminateException) {
      return Promise.resolve({totalFrames: 0, backtrace: []});
    }

    if (!this.lastBreakpointHit) {
      return Promise.reject(
          new Error('backtrace not allowed while app running'));
    }

    return this.sendRequest(encodeMessage(
        this.byteConfig, 'BIIB',
        [SP.CLIENT.ESCARGOT_DEBUGGER_GET_BACKTRACE, start, start + levels, 1]));
  }

  logPacket(description: string, ignorable: boolean = false) {
    // certain packets are ignored while evals are pending
    const ignored = (ignorable && this.evalsPending.length) ? 'Ignored: ' : '';
    this.log(`${ignored}${description}`, LOG_LEVEL.PROTOCOL);
  }

  private abort(message: string) {
    if (this.delegate.onError) {
      this.log(`Abort: ${message}`, LOG_LEVEL.ERROR);
      this.delegate.onError(0, message);
    }
  }

  private resumeExec(code: number): Promise<any> {
    if (!this.lastBreakpointHit) {
      return Promise.reject(
          new Error('attempted resume while not at breakpoint'));
    }

    this.lastBreakpointHit = undefined;
    this.lastStopType = code;
    const result =
        this.sendSimpleRequest(encodeMessage(this.byteConfig, 'B', [code]));

    if (this.delegate.onResume) {
      this.delegate.onResume();
    }

    return result;
  }

  public sendClientSourceEnd(): Promise<any> {
    return this.sendSimpleRequest(encodeMessage(
        this.byteConfig, 'B',
        [SP.CLIENT.ESCARGOT_DEBUGGER_THERE_WAS_NO_SOURCE]));
  }

  public sendClientSource(program): Promise<any> {
    if (!this.waitForSourceEnabled) {
      return Promise.reject(new Error('wait-for-source not enabled'));
    }

    if (!program.name) {
      return this.sendClientSourceEnd();
    }

    let {name: fileName, source: fileSourceCode} = program;

    return this.sendString(
        SP.CLIENT.ESCARGOT_DEBUGGER_CLIENT_SOURCE_8BIT_START,
        fileName + '\0' + fileSourceCode, true);
  }

  private onWaitForSource(): void {
    this.waitForSourceEnabled = true;
    if (this.delegate.onWaitForSource) {
      this.delegate.onWaitForSource();
    }
  }

  public setWaitBeforeExit(value: boolean): void {
    this.waitBeforeExit = value;
  }

  private onWaitForWaitExit(): void {
    this.logPacket('onWaitForWaitExit');

    this.sendSimpleRequest(encodeMessage(
      this.byteConfig, 'BB', [SP.CLIENT.ESCARGOT_DEBUGGER_WAIT_BEFORE_EXIT, this.waitBeforeExit ? 1 : 0]));
  }

  private sendRequest(data: Uint8Array): Promise<any> {
    const request = new PendingRequest(data);

    if (this.currentRequest !== null) {
      this.requestQueue = [...this.requestQueue, request];
    } else {
      if (!this.submitRequest(request)) {
        return Promise.reject(new Error('Failed to submit request.'));
      }
    }

    return request.promise;
  }

  private sendSimpleRequest(data: Uint8Array): Promise<any> {
    const request = new PendingRequest(data);

    if (!this.submitRequest(request, true)) {
      return Promise.reject(new Error('Failed to submit request.'));
    }

    return Promise.resolve();
  }

  private submitRequest(request: PendingRequest, simple: boolean = false):
      boolean {
    if (!this.debuggerClient!.send(request.data))
      return false;
    if (!simple)
      this.currentRequest = request;
    return true;
  }
}
