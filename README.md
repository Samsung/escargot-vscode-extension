# Escargot debug extension for VSCode.


[![License](https://img.shields.io/badge/licence-Apache%202.0-brightgreen.svg?style=flat)](LICENSE)

- [Introduction](#introduction)
- [Features](#features)
- [Requirements](#requirements)
- [How to use](#how-to-use)
- [License](#license)

# Introduction
`Escargot VSCode Extension` is a debugger extension for [Visual Studio Code](https://code.visualstudio.com/) that lets you debug the code which is running on a device, lets you upload your code to the device, directly from the VSCode over websocket communication and helps you to write code with [Escargot](https://github.com/Samsung/escargot).

# Features
- Debugger
  - Available Control commands:
    - Continue command
    - Pause command
    - Step-over command
    - Step-in command
    - Step-out command
    - Disconnect command

  - Available features:
    - Set/Remove breakpoints
    - Set/Remove function breakpoints
    - Call stack display
    - Variables display
    - Watch (evaluate expression)
    - Exception hint
    - Handle source receive from the engine
    - Sending source code from the vscode to the engine
    - Automatic Escargot debug server launch
    - Multiple source handling with quickpicklist
    - Multiple source handling with list of files
    - Stop after finish running


# Requirements
- The latest Vscode which is available [here](https://code.visualstudio.com/Download).
- An [Escargot](https://github.com/Samsung/escargot) as an engine to run your code.

- (For development) Requires [node.js](https://nodejs.org/en/) v8.x.x or higher (latest one is recommended) and [npm](https://www.npmjs.com) 5.x.x or higher to be able to work properly.

# How to use
You have to open (or create a new) project folder where you have to define a `launch.json` configuration file inside the `.vscode` folder. In case of Escagot Debug this configuration looks like this:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Escargot: Attach",
      "type": "escargot",
      "request": "attach",
      "address": "localhost",
      "port": 6501,
      "localRoot": "${workspaceRoot}",
      "debugLog": 0
    },
  ]
}
```

These configuration options are required. Manifest:
- `name`: The name which will be visible in the debug view
- `type`: This must be `escargot` otherwise the debug session wont start
- `request`: Type of the session start
- `address`: IP address on which the server listening. Default is `localhost`
- `port`: Port on which the server listening. Default is `6501`
- `localRoot`: The local source root directoy, most cases this is the `${workspaceRoot}`
- `debugLog`: The type of the debug log, you can choose from 0 to 4:
    - 0: none
    - 1: Error (show errors only)
    - 2: Debug Session related (requests and their responses)
    - 3: Debug Protocol related (communication between the engine and the client)
    - 4: Verbose (each log type included)

You can also define [Launch](#launch) instead of Attach to automate starting debug server.

Now you can connect to a running engine.
Detailed instruction:

```sh
# Open up a new terminal window and navigate into the Escargot root folder
$ cd path/to/the/escargot

# Build the engine with the following options
$ cmake -DESCARGOT_HOST=linux -DESCARGOT_ARCH=x64 -DESCARGOT_MODE=RELEASe -DESCARGOT_OUTPUT=shell -DESCARGOT_DEBUGGER=1 -GNinja
$ ninja

# Run the Escargot with the following options
$ ./escargot --start-debug-server {file}

# To run with source waiting mode (allows the on-the-fly source code sending)
$ ./escargot --start-debug-server --debugger-wait-source
```

# Launch
Alternatively you can use LaunchRequest instead of AttachRequest for automatic debug server launch.
In case of Escargot Debug it looks like this:
```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "Escargot.js: Launch",
      "type": "escargot",
      "request": "launch",
      "program": "absolue/path/to/escargot",
      "address": "localhost",
      "localRoot": "${workspaceRoot}",
      "wait_for_source_mode": "quickpicklist",
      "debugLog": 0,
      "args": [
          "--start-debug-server",
          "--debugger-wait-source"
      ]
    }
  ]
}
```

These configuration options are required. Manifest:
- `name`: The name which will be visible in the debug view
- `type`: This must be `escargot` otherwise the debug session wont start
- `request`: Type of the session start
- `program`: Runtime executable for debug server. Default is `escargot`. If you debug on desktop use
absolute path to executable (e.g.:/path/to/escargot/folder/escargot)
- `address`: IP address on which the server listening. Default is `localhost`
- `localRoot`: The local source root directoy, most cases this is the `${workspaceRoot}`
- `wait_for_source_mode`: The type of processing input file(s)
    - quickpicklist: Select files from a list (files of escargot-test folder), they are executed in the same order they are selected
    - xy.txt: Files will be executed in the same order as they are in a custom txt file (filename can be anything)
    - If this parameter isnt there, please add the filename you would like to run in the "args" section, and only that file will be executed
- `debugLog`: The type of the debug log, you can choose from 0 to 4:
    - 0: none
    - 1: Error (show errors only)
    - 2: Debug Session related (requests and their responses)
    - 3: Debug Protocol related (communication between the engine and the client)
    - 4: Verbose (each log type included)
- `args`: Arguments for debug server. Recommended to use --start-debug-server, --debugger-wait-source and --wait-before-exit.


After the engine is running you can start the debug session inside the extension host by pressing the `F5` key or click on the green triangle in the debug panel.
If the client (VSCode extension) is connected then you have to see that file which is running inside the engine or if you started the engine in waiting mode you will get a prompt window where you can select that file what you want to running and then you can see where the execution is stopped. Now you can use the VSCode debug action bar to control the debug session.

***Important note:*** When sending multiple sources to debug server, be aware that Escargot compiles them in the order they are selected.

***Note:*** If you using the development version of this extension, you have to run the following commands for the first time in the extension directory:

```bash
# Install the node modules
$ npm install

# Compile the extension into the out folder
$ npm run compile

# For automatic complination
$ npm run watch
```
If you want to use the development extension just like any other extension in your VSCode then copy the project folder into the VSCode extensions folder:
```bash
# Assume that you are in the extension root folder
$ ln -s . ~/.vscode/extensions/escargot-vscode-extension
```

# License
Escargot VSCode extension is Open Source software under the [Apache 2.0 license](LICENSE). Complete license and copyright information can be found within the code.
