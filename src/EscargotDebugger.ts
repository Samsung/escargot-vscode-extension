/*
 * Copyright 2020-present Samsung Electronics Co., Ltd. and other contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

import {DebugSession, InitializedEvent, OutputEvent, LoadedSourceEvent, Thread, StoppedEvent, StackFrame, TerminatedEvent, ErrorDestination, Scope, Event,} from 'vscode-debugadapter';
import {DebugProtocol} from 'vscode-debugprotocol';
import * as Util from 'util';
import * as Cp from 'child_process';
import NodeSSH from 'node-ssh';
import {IAttachRequestArguments, ILaunchRequestArguments, TemporaryBreakpoint, SourceSendingOptions} from './EscargotDebuggerInterfaces';
import {EscargotDebuggerClient, EscargotDebuggerOptions} from './EscargotDebuggerClient';
import {EscargotDebugProtocolDelegate, EscargotDebugProtocolHandler, EscargotMessageScriptParsed, EscargotMessageBreakpointHit, EscargotBacktraceResult, EscargotScopeChain, EscargotScopeVariable,} from './EscargotProtocolHandler';
import {Breakpoint} from './EscargotBreakpoints';
import {LOG_LEVEL, SOURCE_SENDING_STATES} from './EscargotDebuggerConstants';

class EscargotDebugSession extends DebugSession {
  // We don't support multiple threads, so we can use a hardcoded ID for the
  // default thread
  private static THREAD_ID = 1;

  private _attachArgs: IAttachRequestArguments;
  private _launchArgs: ILaunchRequestArguments;
  private _escargotProcess: Cp.ChildProcess = null;
  private _debugLog: number = 0;
  private _debuggerClient: EscargotDebuggerClient;
  private _protocolhandler: EscargotDebugProtocolHandler;
  private _sourceSendingOptions: SourceSendingOptions;

  public constructor() {
    super();

    // The debugger uses zero-based lines and columns.
    this.setDebuggerLinesStartAt1(false);
    this.setDebuggerColumnsStartAt1(false);
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    // Runtime supports now threads so just return a default thread.
    response.body = {
      threads: [new Thread(EscargotDebugSession.THREAD_ID, 'Main Thread')]
    };
    this.sendResponse(response);
  }

  /**
   * The 'initialize' request is the first request called by the frontend
   * to interrogate the debug adapter about the features it provides.
   */
  protected initializeRequest(
      response: DebugProtocol.InitializeResponse,
      args: DebugProtocol.InitializeRequestArguments): void {
    // This debug adapter implements the configurationDoneRequest.
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsEvaluateForHovers = false;
    response.body.supportsStepBack = false;
    response.body.supportsDelayedStackTraceLoading = true;
    response.body.supportsSetVariable = false;

    this._sourceSendingOptions =
        <SourceSendingOptions>{state: SOURCE_SENDING_STATES.NOP};

    this.sendResponse(response);
  }

  protected configurationDoneRequest(
      response: DebugProtocol.ConfigurationDoneResponse,
      args: DebugProtocol.ConfigurationDoneArguments): void {
    super.configurationDoneRequest(response, args);
  }

  protected attachRequest(
      response: DebugProtocol.AttachResponse,
      args: IAttachRequestArguments): void {
    if (!args.address || args.address === '') {
      this.sendErrorResponse(response, new Error('Must specify an address'));
      return;
    }

    if (!args.localRoot || args.localRoot === '') {
      this.sendErrorResponse(response, new Error('Must specify a localRoot'));
      return;
    }

    this._attachArgs = args;
    if (!this._attachArgs.port) {
      this._attachArgs.port = 6501;
    }
    if (args.debugLog in LOG_LEVEL) {
      this._debugLog = args.debugLog;
    } else {
      this.sendErrorResponse(response, new Error('No log level given'));
    }

    this.connectToDebugServer(response, args);
  }

  protected launchRequest(
      response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
    if (!args.address || args.address === '') {
      this.sendErrorResponse(response, new Error('Must specify an address'));
      return;
    }

    if (!args.localRoot || args.localRoot === '') {
      this.sendErrorResponse(response, new Error('Must specify a localRoot'));
      return;
    }

    this._launchArgs = args;
    this._launchArgs.port = 6501;
    if (args.debugLog in LOG_LEVEL) {
      this._debugLog = args.debugLog;
    } else {
      this.sendErrorResponse(response, new Error('No log level given'));
    }

    const launchScript = () => {
      const programArgs = args.args || [];
      const cwd = args.localRoot || process.cwd();
      const env = args.env || process.env;
      let ssh = new NodeSSH();

      if (args.address === 'localhost') {
        const localProcess =
            Cp.spawn(args.program, [...programArgs], {cwd, env});
        localProcess.stdout.on(
            'data',
            (data: Buffer) =>
                this.sendEvent(new OutputEvent(data + '', 'stdout')));
        localProcess.stderr.on(
            'data',
            (data: Buffer) =>
                this.sendEvent(new OutputEvent(data + '', 'stderr')));
        localProcess.on('exit', () => this.sendEvent(new TerminatedEvent()));
        localProcess.on(
            'error',
            (error: Error) =>
                this.sendEvent(new OutputEvent(error.message + '\n')));
        this._escargotProcess = localProcess;
      } else {
        ssh.connect({
             host: args.address,
             username: 'root',
             privateKey: `${process.env.HOME}/.ssh/id_rsa`
           })
            .then(() => {
              ssh.execCommand(
                     `${args.program} ${programArgs.join(' ')}`,
                     )
                  .then((result) => {
                    this.log(result.stdout);
                    this.log(result.stderr);
                  });
            });
      }
    };
    if (args.program) {
      launchScript();
    }
    setTimeout(() => {
      this.connectToDebugServer(response, args);
    }, 500);
  }

  private connectToDebugServer(
      response: DebugProtocol.LaunchResponse|DebugProtocol.AttachResponse,
      args: ILaunchRequestArguments|IAttachRequestArguments): void {
    const protocolDelegate = <EscargotDebugProtocolDelegate>{
      onBreakpointHit: (ref: EscargotMessageBreakpointHit, type: string) =>
          this.onBreakpointHit(ref, type),
      onConnected: () => this.onConnected(),
      onError: (code: number, message: string) => this.onClose(),
      onExceptionHit: (data: string) => this.onExceptionHit(data),
      onScriptParsed: (data: EscargotMessageScriptParsed) =>
          this.onScriptParsed(data),
      onOutput: (message: string, category?: string) =>
          this.logOutput(message, category),
      onWaitForSource: () => this.onWaitForSource(
          (<ILaunchRequestArguments>args).wait_for_source_mode)
    };

    const currentArgs = this._attachArgs || this._launchArgs;
    this._protocolhandler = new EscargotDebugProtocolHandler(
        protocolDelegate,
        currentArgs.localRoot,
        (message: any, level: number = LOG_LEVEL.VERBOSE) =>
            this.log(message, level));
    this._debuggerClient = new EscargotDebuggerClient(<EscargotDebuggerOptions>{
      delegate: {
        onMessage: (message: Uint8Array) =>
            this._protocolhandler.onMessage(message),
        onClose: () => this.onClose()
      },
      host: args.address,
      port: args.port
    });
    this._protocolhandler.debuggerClient = this._debuggerClient;

    this._debuggerClient.connect()
        .then(() => {
          this.log(
              `Connected to: ${args.address}:${args.port}`, LOG_LEVEL.SESSION);
          this.sendResponse(response);
        })
        .catch(error => {
          this.log(error.message, LOG_LEVEL.ERROR);
          this.sendErrorResponse(response, error);
        });
  }

  protected disconnectRequest(
      response: DebugProtocol.DisconnectResponse,
      args: DebugProtocol.DisconnectArguments): void {
    if (this._escargotProcess) {
      this._escargotProcess.kill();
    }

    this._debuggerClient.disconnect();
    this.sendEvent(new TerminatedEvent());
    this.sendResponse(response);
  }


  protected continueRequest(
      response: DebugProtocol.ContinueResponse,
      args: DebugProtocol.ContinueArguments): void {
    this._protocolhandler.resume()
        .then(() => {
          this.sendResponse(response);
        })
        .catch(error => this.sendErrorResponse(response, <Error>error));
  }

  protected nextRequest(
      response: DebugProtocol.NextResponse,
      args: DebugProtocol.NextArguments): void {
    this._protocolhandler.stepOver()
        .then(() => {
          this.sendResponse(response);
        })
        .catch(error => this.sendErrorResponse(response, <Error>error));
  }

  protected stepInRequest(
      response: DebugProtocol.StepInResponse,
      args: DebugProtocol.StepInArguments): void {
    this._protocolhandler.stepInto()
        .then(() => {
          this.sendResponse(response);
        })
        .catch(error => this.sendErrorResponse(response, <Error>error));
  }

  protected stepOutRequest(
      response: DebugProtocol.StepOutResponse,
      args: DebugProtocol.StepOutArguments): void {
    this._protocolhandler.stepOut()
        .then(() => {
          this.sendResponse(response);
        })
        .catch(error => this.sendErrorResponse(response, <Error>error));
  }

  protected pauseRequest(
      response: DebugProtocol.PauseResponse,
      args: DebugProtocol.PauseArguments): void {
    this._protocolhandler.pause()
        .then(() => {
          this.sendResponse(response);
        })
        .catch(error => this.sendErrorResponse(response, <Error>error));
  }

  protected sourceRequest(
      response: DebugProtocol.SourceResponse,
      args: DebugProtocol.SourceArguments,
      request?: DebugProtocol.Request): void {

    response.body = {
      content: this._protocolhandler.getSource(args.sourceReference)
    };

    this.sendResponse(response);
  }

  protected async setBreakPointsRequest(
      response: DebugProtocol.SetBreakpointsResponse,
      args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
    var scriptId: number = args.source.sourceReference || 0;
    const vscodeBreakpoints: DebugProtocol.Breakpoint[] =
        args.breakpoints!.map(b => ({verified: false, line: b.line}));

    try {
      if (scriptId == 0) {
        scriptId = this._protocolhandler.getScriptIdByPath(args.source.path);
      }

      const activeBps: Breakpoint[] =
          this._protocolhandler.getActiveBreakpointsByScriptId(scriptId);

      // Get the new breakpoints.
      const activeBpsLines: number[] = activeBps.map(b => b.line);
      const newBps: DebugProtocol.Breakpoint[] =
          vscodeBreakpoints.filter(b => activeBpsLines.indexOf(b.line) === -1);

      const newBreakpoints: TemporaryBreakpoint[] =
          await Promise.all(newBps.map(async (breakpoint, index) => {
            try {
              const escargotBreakpoint: Breakpoint =
                  this._protocolhandler.findBreakpoint(
                      scriptId, breakpoint.line);
              await this._protocolhandler.updateBreakpoint(
                  escargotBreakpoint, true);
              return <TemporaryBreakpoint>{
                verified: true,
                line: breakpoint.line
              };
            } catch (error) {
              this.log(error.message, LOG_LEVEL.ERROR);
              return <TemporaryBreakpoint>{
                verified: false,
                line: breakpoint.line,
                message: (<Error>error).message
              };
            }
          }));

      // Get the persisted breakpoints.
      const newBreakpointsLines: number[] = newBreakpoints.map(b => b.line);
      const persistingBreakpoints: TemporaryBreakpoint[] =
          vscodeBreakpoints
              .filter(b => newBreakpointsLines.indexOf(b.line) === -1)
              .map(b => ({verified: true, line: b.line}));

      // Get the removable breakpoints.
      const vscodeBreakpointsLines: number[] =
          vscodeBreakpoints.map(b => b.line);
      const removeBps: Breakpoint[] =
          activeBps.filter(b => vscodeBreakpointsLines.indexOf(b.line) === -1);

      removeBps.forEach(async b => {
        const escargotBreakpoint =
            this._protocolhandler.findBreakpoint(scriptId, b.line);
        await this._protocolhandler.updateBreakpoint(escargotBreakpoint, false);
      });

      response.body = {
        breakpoints: [...persistingBreakpoints, ...newBreakpoints]
      };
    } catch (error) {
      this.log(error.message, LOG_LEVEL.ERROR);

      response.body = {
        breakpoints: vscodeBreakpoints
      };
    }

    this.sendResponse(response);
  }

  protected async stackTraceRequest(
      response: DebugProtocol.StackTraceResponse,
      args: DebugProtocol.StackTraceArguments): Promise<void> {
    try {
      const backtraceData: EscargotBacktraceResult =
          await this._protocolhandler.requestBacktrace(
              args.startFrame, args.levels);
      const stk = backtraceData.backtrace.map(
          (f, i) => new StackFrame(
              f.id, f.function.name,
              this._protocolhandler.getReference(f.function.scriptId),
              f.line, f.column));

      response.body = {
        stackFrames: stk,
        totalFrames: backtraceData.totalFrames
      };

      this.sendResponse(response);
    } catch (error) {
      this.log(error.message, LOG_LEVEL.ERROR);
      this.sendErrorResponse(response, 0, (<Error>error).message);
    }
  }

  protected async evaluateRequest(
      response: DebugProtocol.EvaluateResponse,
      args: DebugProtocol.EvaluateArguments): Promise<void> {
    try {
      const result: string =
          await this._protocolhandler.evaluate(args.expression, 0);

      response.body = {result, variablesReference: 0};

      this.sendResponse(response);
    } catch (error) {
      this.sendErrorResponse(response, 0, (<Error>error).message);
    }
  }

  protected async scopesRequest(
      response: DebugProtocol.ScopesResponse,
      args: DebugProtocol.ScopesArguments): Promise<void> {
    try {
      const btDepth =
          this._protocolhandler.resolveBacktraceFrameDepthByID(args.frameId);
      const scopesArray: Array<EscargotScopeChain> =
          await this._protocolhandler.requestScopes(btDepth);
      const scopes = new Array<Scope>();

      for (const scope of scopesArray) {
        this._protocolhandler.setScopeChainElementState(scope.scopeID, btDepth);
        scopes.push(new Scope(scope.name, scope.scopeID, scope.expensive));
      }

      response.body = {scopes: scopes};

      this.sendResponse(response);
    } catch (error) {
      this.log(error.message, LOG_LEVEL.ERROR);
      this.sendErrorResponse(response, 0, (<Error>error).message);
    }
  }

  protected async variablesRequest(
      response: DebugProtocol.VariablesResponse,
      args: DebugProtocol.VariablesArguments): Promise<void> {
    try {
      const variables = new Array<DebugProtocol.Variable>();
      let scopeVariables: Array<EscargotScopeVariable>;
      const {scopeIndex, stateIndex} =
          this._protocolhandler.resolveScopeChainElementByID(
              args.variablesReference);

      if (stateIndex === -1) {
        scopeVariables =
            await this._protocolhandler.requestObjectVariables(scopeIndex);
      } else {
        scopeVariables = await this._protocolhandler.requestScopeVariables(
            stateIndex, scopeIndex);
      }

      for (const variable of scopeVariables) {
        let variablesReference = 0;
        if (variable.objectIndex !== -1) {
          variablesReference = this._protocolhandler.addScopeVariableObject(
              variable.objectIndex);
        }

        variables.push({
          name: variable.name,
          evaluateName: variable.name,
          type: variable.type,
          value: variable.value,
          variablesReference
        });
      }

      response.body = {variables: variables};
      this.sendResponse(response);
    } catch (error) {
      this.log(error.message, LOG_LEVEL.ERROR);
      this.sendErrorResponse(response, 0, (<Error>error).message);
    }
  }

  protected customRequest(
      command: string, response: DebugProtocol.Response, args: any): void {
    switch (command) {
      case 'sendSource': {
        this._sourceSendingOptions.state = SOURCE_SENDING_STATES.IN_PROGRESS;
        this._protocolhandler.sendClientSource(args.program)
            .then(() => {
              this.log(
                  'Source has been sent to the engine.', LOG_LEVEL.SESSION);
              this._sourceSendingOptions.state = SOURCE_SENDING_STATES.WAITING;
              if (args.program.isLast) {
                this._sourceSendingOptions.state =
                    SOURCE_SENDING_STATES.LAST_SENT;
              }
              this.sendResponse(response);
            })
            .catch(error => {
              this.log(error.message, LOG_LEVEL.ERROR);
              this._sourceSendingOptions.state = SOURCE_SENDING_STATES.NOP;
              this.sendErrorResponse(
                  response, <Error>error, ErrorDestination.User);
            });
        return;
      }
      default:
        super.customRequest(command, response, args);
    }
  }

  // Overrides.
  protected dispatchRequest(request: DebugProtocol.Request): void {
    const log = `-> ${request.command}Request\n${
        Util.inspect(request, {depth: Infinity})}\n`;
    this.log(log, LOG_LEVEL.SESSION);

    super.dispatchRequest(request);
  }

  public sendResponse(response: DebugProtocol.Response): void {
    const log = `<- ${response.command}Response\n${
        Util.inspect(response, {depth: Infinity})}\n`;
    this.log(log, LOG_LEVEL.SESSION);

    super.sendResponse(response);
  }

  public sendEvent(event: DebugProtocol.Event, bypassLog: boolean = false):
      void {
    if (!bypassLog) {
      const log =
          `<- ${event.event}Event\n${Util.inspect(event, {depth: Infinity})}\n`;
      this.log(log, LOG_LEVEL.SESSION);
    }

    super.sendEvent(event);
  }

  protected sendErrorResponse(
      response: DebugProtocol.Response, error: Error,
      dest?: ErrorDestination): void;

  protected sendErrorResponse(
      response: DebugProtocol.Response,
      codeOrMessage: number|DebugProtocol.Message, format?: string,
      variables?: any, dest?: ErrorDestination): void;

  protected sendErrorResponse(response: DebugProtocol.Response) {
    if (arguments[1] instanceof Error) {
      const error = arguments[1] as Error & {
        code?: number|string;
        errno?: number
      };
      const dest = arguments[2] as ErrorDestination;

      let code: number;

      if (typeof error.code === 'number') {
        code = error.code as number;
      } else if (typeof error.errno === 'number') {
        code = error.errno;
      } else {
        code = 0;
      }

      super.sendErrorResponse(response, code, error.message, dest);
    } else {
      super.sendErrorResponse(
          response, arguments[1], arguments[2], arguments[3], arguments[4]);
    }
  }

  // Helper functions for event handling

  private onBreakpointHit(
      breakpointRef: EscargotMessageBreakpointHit, stopType: string): void {
    this.log('onBreakpointHit', LOG_LEVEL.SESSION);

    this.sendEvent(new StoppedEvent(stopType, EscargotDebugSession.THREAD_ID));
  }

  private onExceptionHit(data: string): void {
    this.log('onExceptionHit', LOG_LEVEL.SESSION);

    this.sendEvent(
        new StoppedEvent('exception', EscargotDebugSession.THREAD_ID, data));
  }

  private onScriptParsed(data: EscargotMessageScriptParsed): void {
    this.log('onScriptParsed', LOG_LEVEL.SESSION);

    this.handleSource(data);
  }

  private async onWaitForSource(mode?: string): Promise<void> {
    this.log('onWaitForSource', LOG_LEVEL.SESSION);

    if (this._sourceSendingOptions.state === SOURCE_SENDING_STATES.NOP) {
      this.sendEvent(new Event('readSources', mode));
      this._sourceSendingOptions.state = SOURCE_SENDING_STATES.WAITING;
    } else if (
        this._sourceSendingOptions.state === SOURCE_SENDING_STATES.WAITING) {
      this.sendEvent(new Event('sendNextSource'));
    } else if (
        this._sourceSendingOptions.state === SOURCE_SENDING_STATES.LAST_SENT) {
      if (!this._sourceSendingOptions.contextReset) {
        this._sourceSendingOptions.state = SOURCE_SENDING_STATES.NOP;
        this._protocolhandler.sendClientSourceEnd();
      }
    }
  }

  private onConnected(): void {
    this.log('onConnected', LOG_LEVEL.SESSION);

    this.sendEvent(new InitializedEvent());
  }

  private onClose(): void {
    this.log('onClose', LOG_LEVEL.SESSION);

    this.sendEvent(new TerminatedEvent());
  }

  // General helper functions

  private handleSource(data: EscargotMessageScriptParsed): void {
    if (this._protocolhandler.getReference(data.id).sourceReference)
      this.sendEvent(new LoadedSourceEvent('new', this._protocolhandler.getReference(data.id)));
    this.sendEvent(new InitializedEvent());
  }

  private log(message: any, level: number = LOG_LEVEL.VERBOSE): void {
    if (level === this._debugLog || this._debugLog === LOG_LEVEL.VERBOSE) {
      switch (typeof message) {
        case 'object':
          message = Util.inspect(message, {depth: Infinity});
          break;
        default:
          message = message.toString();
          break;
      }

      this.sendEvent(
          new OutputEvent(`[${LOG_LEVEL[level]}] ${message}\n`, 'console'),
          true);
    }
  }

  private logOutput(message: any, category: string = 'stdout'): void {
    this.sendEvent(new OutputEvent(`${message}\n`, category), true);
  }
}

DebugSession.run(EscargotDebugSession);
