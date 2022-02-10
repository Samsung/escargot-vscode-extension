/*
 * Copyright 2020-present Samsung Electronics Co., Ltd. and other contributors
 * Copyright JS Foundation and other contributors, http://js.foundation
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

export interface ByteConfig {
  pointerSize: number;
  littleEndian: boolean;
}

/**
 * Calculates expected byte length given a format string
 *
 * @param endia  Byte order / size info
 * @param format  String of 'B', 'C', and 'I' characters
 */
export const getFormatSize = (config: ByteConfig, format: string) => {
  let length = 0;
  format.split('').forEach(f => {
    switch (f) {
      case 'B':
        length++;
        break;

      case 'C':
        length += config.pointerSize;
        break;

      case 'I':
        length += 4;
        break;

      default:
        throw new Error('unsupported message format');
    }
  });
  return length;
};

/**
 * Returns a 32-bit integer read from array at offset, in either direction
 *
 * @param littleEndian Byte order to use
 * @param array        Array with length >= offset + 3
 * @param offset       Offset at which to start reading
 */
export const getUint32 =
    (littleEndian: boolean, array: Uint8Array, offset: number) => {
      let value = 0;
      if (littleEndian) {
        value = array[offset];
        value |= array[offset + 1] << 8;
        value |= array[offset + 2] << 16;
        value |= array[offset + 3] << 24;
      } else {
        value = array[offset] << 24;
        value |= array[offset + 1] << 16;
        value |= array[offset + 2] << 8;
        value |= array[offset + 3];
      }
      return value >>> 0;
    };

/**
 * Writes a 32-bit integer to array at offset, in either direction
 *
 * @param littleEndian Byte order to use
 * @param array        Array with length >= offset + 3
 * @param offset       Offset at which to start writing
 * @param value        Value to write in 32-bit integer range
 */
export const setUint32 =
    (littleEndian: boolean, array: Uint8Array, offset: number,
     value: number) => {
      if (littleEndian) {
        array[offset] = value & 0xff;
        array[offset + 1] = (value >> 8) & 0xff;
        array[offset + 2] = (value >> 16) & 0xff;
        array[offset + 3] = (value >> 24) & 0xff;
      } else {
        array[offset] = (value >> 24) & 0xff;
        array[offset + 1] = (value >> 16) & 0xff;
        array[offset + 2] = (value >> 8) & 0xff;
        array[offset + 3] = value & 0xff;
      }
    };

/**
 * Parses values out of message array matching format
 *
 * Throws if message not big enough for specified format or bogus format
 * character
 *
 * @param config  Byte order / size info
 * @param format  String of 'B', 'C', and 'I' characters
 * @param message Array containing message
 * @param offset  Optional offset at which to start reading
 */
export const decodeMessage =
    (config: ByteConfig, format: string, message: Uint8Array,
     offset: number = 0) => {
      // Format: B=byte I=int32 C=cpointer
      // Returns an array of decoded numbers

      const result = [];
      let value;

      if (offset + getFormatSize(config, format) > message.byteLength) {
        throw new Error('received message too short');
      }

      format.split('').forEach(f => {
        if (f === 'B') {
          result.push(message[offset++]);
          return;
        }

        if (f === 'C' && config.pointerSize === 8) {
          value = String.fromCharCode(...message.subarray(offset, offset + 8));
          result.push(value);
          offset += 8;
          return;
        }

        if (f !== 'I' && (f !== 'C' || config.pointerSize !== 4)) {
          throw new Error('unexpected decode request');
        }

        value = getUint32(config.littleEndian, message, offset);
        result.push(value);
        offset += 4;
      });

      return result;
    };

/**
 * Packs values into new array according to format
 *
 * Throws if not enough values supplied or values exceed expected integer ranges
 *
 * @param config Byte order / size info
 * @param format String of 'B', 'C', and 'I' characters
 * @param values Array of values to format into message
 */
export const encodeMessage =
    (config: ByteConfig, format: string, values: Array<any>) => {
      const length = getFormatSize(config, format);
      const message = new Uint8Array(length);
      let offset = 0;

      if (values.length < format.length) {
        throw new Error('not enough values supplied');
      }

      format.split('').forEach((f, i) => {
        const value = values[i];

        if (f === 'B') {
          if ((value & 0xff) !== value) {
            throw new Error('expected byte value');
          }
          message[offset++] = value;
          return;
        }

        if (f === 'C' && config.pointerSize === 8) {
          for (let i = 0; i < 8; i++) {
            message[offset++] = value.charCodeAt(i);
          }
          return;
        }

        if (f !== 'I' && (f !== 'C' || config.pointerSize !== 4)) {
          throw new Error('unexpected encode request');
        }

        if ((value & 0xffffffff) !== value) {
          throw new Error('expected four-byte value');
        }

        setUint32(config.littleEndian, message, offset, value);
        offset += 4;
      });

      return message;
    };

export const createStringFromArray =
    (array: Uint8Array|Uint16Array|undefined) => {
      if (!array) {
        return '';
      }

      return String.fromCharCode(...array);
    };

export const createArrayFromString = (config: ByteConfig, str: string) => {
  let chars = Uint8Array.from([...str].map(x => x.charCodeAt(0)));

  if (!config.littleEndian) {
    for (let i = 1; i < chars.length; i += 2) {
      let tmp = chars[i];
      chars[i] = chars[i + 1];
      chars[i + 1] = tmp;
    }
  }

  return chars;
};


// Concat the two arrays. The first byte (opcode) of nextArray is ignored.
export const assembleUint8Arrays =
    (baseArray: Uint8Array|undefined, nextArray: Uint8Array) => {
      if (!baseArray) {
        // Cut the first byte (opcode)
        return nextArray.slice(1);
      }

      if (nextArray.byteLength <= 1) {
        // Nothing to append
        return baseArray;
      }

      const baseLength = baseArray.byteLength;
      const nextLength = nextArray.byteLength - 1;

      const result = new Uint8Array(baseLength + nextLength);
      result.set(nextArray, baseLength - 1);

      // This set operation overwrites the opcode
      result.set(baseArray);

      return result;
    };

// Concat the two arrays. The first byte (opcode) of nextArray is ignored.
export const assembleUint16Arrays =
    (config: ByteConfig, baseArray: Uint16Array|undefined,
     nextArray: Uint8Array) => {
      if (!config.littleEndian) {
        for (let i = 1; i < nextArray.length; i += 2) {
          let tmp = nextArray[i];
          nextArray[i] = nextArray[i + 1];
          nextArray[i + 1] = tmp;
        }
      }

      let u16Array = new Uint16Array(nextArray.slice(1).buffer);

      if (!baseArray) {
        return u16Array;
      }

      if (nextArray.byteLength <= 1) {
        return baseArray;
      }

      const baseLength = baseArray.length;
      const u16ArrayLength = u16Array.length;

      const result = new Uint16Array(baseLength + u16ArrayLength);
      result.set(u16Array, baseLength);
      result.set(baseArray);

      return result;
    };
