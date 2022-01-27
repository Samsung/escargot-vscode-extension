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

import { DebugProtocol } from 'vscode-debugprotocol';

export interface IAttachRequestArguments extends DebugProtocol.AttachRequestArguments {
  /** IP address on which the server listening. */
  address: string;
  /** Debug port to attach to. */
  port: number;
  /** VSCode's root directory. */
  localRoot: string;
  /** Allows to log debug messages to console. */
  debugLog: number;
  /** Filename. */
  program?: string;
}

export interface SourceSendingOptions {
  // Actual state of source sending.
  state: number;
}

export interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  /** This is the absolute path to escargot executable. */
  program: string;
  /** This allows to log debug messages to console. */
  debugLog: number;
  /** Optional arguments to be passed. */
  args?: string[];
  /** VSCode's root directory.*/
  localRoot: string;
  /** Additional environment variables */
  env?: { [key: string]: string };
  /** The IP address on which the server is listening. Default value is localhost. */
  address: string;
  /** Debug port.*/
  port: number;
  /** Execution mode if running multiple files. */
  wait_for_source_mode?: string;
}

export interface SourceSendingOptions {
  // Engine context reset is available or not.
  contextReset: boolean;
  // Actual state of source sending.
  state: number;
}

export interface TemporaryBreakpoint {
  // The breakpoint is verified or not by the engine.
  verified: boolean;
  // Line position in the file.
  line: number;
  // Extra error or info message.
  message?: string;
}
