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

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let sources: string[];
let pathArray = [];

const defaultConfig = [{
  name: 'Escargot: Attach',
  type: 'escargot',
  request: 'attach',
  address: 'localhost',
  localRoot: '${workspaceRoot}',
  debugLog: 0,
}];

const provideInitialConfigurations = (): string => {
  const config = JSON.stringify(defaultConfig, null, '\t').split('\n')
                                                          .map(line => '\t' + line)
                                                          .join('\n').trim();

  return [
    '{',
    '\t"version": "0.2.0",',
    `\t"configurations": ${config}`,
    '}'
  ].join('\n');
};

const walkSync = (dir: string, filelist: string[] = []): string[] => {
  fs.readdirSync(dir).forEach(file => {
    filelist = fs.statSync(path.join(dir, file)).isDirectory()
      ? walkSync(path.join(dir, file), filelist)
      : filelist.concat(path.join(dir, file));
  });

  return filelist.filter(f => path.extname(f).toLowerCase().match(/\.(js)$/i) && f !== '' && (fs.statSync(f).size) > 0);
};

const getProgramSource = (path: string[]): string[] => {
  return path.map((p) => {
    return fs.readFileSync(p, {
      encoding: 'utf8',
      flag: 'r'
    });
  });

};

const getListOfFiles = (): string[] => {
  let wsFiles: string[] = [];

  vscode.workspace.workspaceFolders.map(folder => folder.uri.fsPath).forEach(entry => {
    wsFiles = [...wsFiles, ...walkSync(entry)];
  });

  return wsFiles;
};

const getProgramName = (): Thenable<string[]> => {
  return vscode.window.showQuickPick(getListOfFiles(), {
    placeHolder: 'Select a file you want to debug',
    canPickMany: true,
    ignoreFocusOut: true,
    onDidSelectItem: item => {
      if (pathArray.indexOf(item.toString()) === -1) {
        pathArray.push(item.toString());
      } else {
        pathArray.splice(pathArray.indexOf(item.toString()), 1);
      }
     }
   });
 };

const processCustomEvent = async (e: vscode.DebugSessionCustomEvent): Promise<any> => {
  let eventType: string = e.event;
  switch (eventType) {
    case 'readSources': {
      pathArray = [];

      if(e.body == "quickpicklist") {
        await getProgramName().then(path => path);
      }

      else if(e.body.endsWith(".txt")) {
        let data = [];
        let folder_path = vscode.workspace.workspaceFolders[0].uri.fsPath;
        data = fs.readFileSync(path.join(folder_path, e.body),'utf8').toString().split("\n");
        for(let i = 0; i < data.length; i++) {
          if (!data[i] || data[i].toString().trim().startsWith("#")) {
            delete data[i];
          } else {
            if (pathArray.indexOf(data[i].toString()) === -1) {
              pathArray.push(path.join(folder_path,data[i].toString()));
            }
          }
        }
      }

      sources = getProgramSource(pathArray);
      break;
    }
    case 'sendNextSource': {
      break;
    }
    default: {
      return undefined;
    }
  }

  let program = {};
  if (sources.length) {
    program = {
      name: pathArray.shift(),
      source: sources.shift(),
      isLast: sources.length === 0
    };
  }

  let retries = 0;
  while (!vscode.debug.activeDebugSession) {
    await new Promise(f => setTimeout(f, 100));

    if (++retries > 100) {
      return undefined;
    }
  }

  vscode.debug.activeDebugSession.customRequest('sendSource', { program });
  return true;
};

export const activate = (context: vscode.ExtensionContext) => {
  context.subscriptions.push(
    vscode.commands.registerCommand('escargot-debug.provideInitialConfigurations', provideInitialConfigurations),
    vscode.debug.onDidReceiveDebugSessionCustomEvent(e => processCustomEvent(e))
    );
  };

export const deactivate = () => {
  // Nothing to do.
};
