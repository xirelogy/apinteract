/**
 * Creates the pure-JavaScript SDK inside QuickJS.
 *
 * The returned bridge is retained only by the host. Workspace code receives
 * the frozen `sdk` member, while `exportResult` keeps mutable invocation state
 * in a closure that cannot be reached by enumerating the guest global object.
 */
export const SCRIPT_SDK_BOOTSTRAP = String.raw`
(function createScriptSdk(input) {
  "use strict";

  function sdkError(code, message) {
    const error = new Error(message);
    Object.defineProperty(error, "name", {
      configurable: true,
      value: "AsdkError",
      writable: true,
    });
    error.code = code;
    return error;
  }

  function requireString(value, name) {
    if (typeof value !== "string") {
      throw sdkError("sdk_invalid_argument", name + " must be a string");
    }
    return value;
  }

  function requireNonEmptyString(value, name) {
    const result = requireString(value, name);
    if (result.length === 0) {
      throw sdkError("sdk_invalid_argument", name + " must not be empty");
    }
    return result;
  }

  function requireBytes(value, name) {
    if (!(value instanceof Uint8Array)) {
      throw sdkError("sdk_invalid_argument", name + " must be a Uint8Array");
    }
    return new Uint8Array(value);
  }

  function utf8Encode(value) {
    const text = requireString(value, "value");
    const output = [];
    for (const character of text) {
      const point = character.codePointAt(0);
      if (point <= 0x7f) {
        output.push(point);
      } else if (point <= 0x7ff) {
        output.push(0xc0 | (point >> 6), 0x80 | (point & 0x3f));
      } else if (point <= 0xffff) {
        output.push(
          0xe0 | (point >> 12),
          0x80 | ((point >> 6) & 0x3f),
          0x80 | (point & 0x3f),
        );
      } else {
        output.push(
          0xf0 | (point >> 18),
          0x80 | ((point >> 12) & 0x3f),
          0x80 | ((point >> 6) & 0x3f),
          0x80 | (point & 0x3f),
        );
      }
    }
    return new Uint8Array(output);
  }

  function utf8Decode(value) {
    const bytes = requireBytes(value, "value");
    let result = "";
    for (let index = 0; index < bytes.length; ) {
      const first = bytes[index];
      let point;
      let length;
      if (first <= 0x7f) {
        point = first;
        length = 1;
      } else if ((first & 0xe0) === 0xc0) {
        point = first & 0x1f;
        length = 2;
      } else if ((first & 0xf0) === 0xe0) {
        point = first & 0x0f;
        length = 3;
      } else if ((first & 0xf8) === 0xf0) {
        point = first & 0x07;
        length = 4;
      } else {
        throw sdkError("sdk_invalid_argument", "value is not valid UTF-8");
      }
      if (index + length > bytes.length) {
        throw sdkError("sdk_invalid_argument", "value is not valid UTF-8");
      }
      for (let offset = 1; offset < length; offset += 1) {
        const next = bytes[index + offset];
        if ((next & 0xc0) !== 0x80) {
          throw sdkError("sdk_invalid_argument", "value is not valid UTF-8");
        }
        point = (point << 6) | (next & 0x3f);
      }
      if (
        (length === 2 && point < 0x80) ||
        (length === 3 && point < 0x800) ||
        (length === 4 && point < 0x10000) ||
        point > 0x10ffff ||
        (point >= 0xd800 && point <= 0xdfff)
      ) {
        throw sdkError("sdk_invalid_argument", "value is not valid UTF-8");
      }
      result += String.fromCodePoint(point);
      index += length;
    }
    return result;
  }

  const base64Alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function base64Encode(value) {
    const bytes = requireBytes(value, "value");
    let result = "";
    for (let index = 0; index < bytes.length; index += 3) {
      const first = bytes[index];
      const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
      const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
      const bits = (first << 16) | (second << 8) | third;
      result += base64Alphabet[(bits >> 18) & 63];
      result += base64Alphabet[(bits >> 12) & 63];
      result +=
        index + 1 < bytes.length ? base64Alphabet[(bits >> 6) & 63] : "=";
      result += index + 2 < bytes.length ? base64Alphabet[bits & 63] : "=";
    }
    return result;
  }

  function base64Decode(value) {
    const text = requireString(value, "value");
    if (text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
      throw sdkError("sdk_invalid_argument", "value is not valid Base64");
    }
    const output = [];
    for (let index = 0; index < text.length; index += 4) {
      const first = base64Alphabet.indexOf(text[index]);
      const second = base64Alphabet.indexOf(text[index + 1]);
      const third = text[index + 2] === "=" ? 0 : base64Alphabet.indexOf(text[index + 2]);
      const fourth = text[index + 3] === "=" ? 0 : base64Alphabet.indexOf(text[index + 3]);
      if (first < 0 || second < 0 || third < 0 || fourth < 0) {
        throw sdkError("sdk_invalid_argument", "value is not valid Base64");
      }
      const bits = (first << 18) | (second << 12) | (third << 6) | fourth;
      output.push((bits >> 16) & 0xff);
      if (text[index + 2] !== "=") output.push((bits >> 8) & 0xff);
      if (text[index + 3] !== "=") output.push(bits & 0xff);
    }
    return new Uint8Array(output);
  }

  function hexEncode(value) {
    const bytes = requireBytes(value, "value");
    let result = "";
    for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
    return result;
  }

  function hexDecode(value) {
    const text = requireString(value, "value");
    if (text.length % 2 !== 0 || !/^[A-Fa-f0-9]*$/.test(text)) {
      throw sdkError("sdk_invalid_argument", "value is not valid hexadecimal");
    }
    const output = new Uint8Array(text.length / 2);
    for (let index = 0; index < output.length; index += 1) {
      output[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
    }
    return output;
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  const parseDate = Date.parse;

  const variableName = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
  const variables = new Map(input.variables.map((variable) => [variable.name, variable]));
  const sensitiveNames = new Set(
    input.variables.filter((variable) => variable.sensitive).map((variable) => variable.name),
  );

  function containsSensitiveReference(value) {
    const expression = /<<([A-Za-z_][A-Za-z0-9_.-]*)>>/g;
    let match;
    while ((match = expression.exec(value)) !== null) {
      if (sensitiveNames.has(match[1])) return true;
    }
    return false;
  }

  function ensureReadable(value, description) {
    if (!value.readable) {
      throw sdkError(
        "sensitive_value_unavailable",
        description + " contains sensitive material and cannot be read",
      );
    }
  }

  function createHeaderApi(entries, mutable) {
    function matches(entry, name) {
      return entry.name.toLowerCase() === name.toLowerCase();
    }

    function matching(name) {
      const checked = requireNonEmptyString(name, "header name");
      return entries.filter((entry) => matches(entry, checked));
    }

    const api = {
      has(name) {
        return matching(name).length > 0;
      },
      get(name) {
        const found = matching(name);
        if (found.length === 0) return undefined;
        ensureReadable(found[0], "Header " + name);
        return found[0].value;
      },
      getAll(name) {
        return Object.freeze(
          matching(name).map((entry) => {
            ensureReadable(entry, "Header " + name);
            return entry.value;
          }),
        );
      },
      entries() {
        return Object.freeze(entries.map((entry) => Object.freeze(cloneJson(entry))));
      },
    };

    if (mutable) {
      api.set = function set(name, value) {
        const checkedName = requireNonEmptyString(name, "header name");
        const checkedValue = requireString(value, "header value");
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          if (matches(entries[index], checkedName)) entries.splice(index, 1);
        }
        entries.push({
          name: checkedName,
          value: checkedValue,
          readable: true,
          sensitive: containsSensitiveReference(checkedValue),
        });
      };
      api.append = function append(name, value) {
        const checkedName = requireNonEmptyString(name, "header name");
        const checkedValue = requireString(value, "header value");
        entries.push({
          name: checkedName,
          value: checkedValue,
          readable: true,
          sensitive: containsSensitiveReference(checkedValue),
        });
      };
      api.remove = function remove(name) {
        const checkedName = requireNonEmptyString(name, "header name");
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          if (matches(entries[index], checkedName)) entries.splice(index, 1);
        }
      };
    }

    return Object.freeze(api);
  }

  function bodySize(body) {
    if (body.kind === "none") return 0;
    if (body.kind === "text") return utf8Encode(body.text || "").byteLength;
    return base64Decode(body.base64 || "").byteLength;
  }

  function ensureBodyWithinLimit(body) {
    if (bodySize(body) > input.limits.bodyBytes) {
      throw sdkError("output_limit_exceeded", "Request body exceeds the script body limit");
    }
  }

  function createRequestBodyApi(state, mutable) {
    const api = {
      get kind() {
        return state.body.kind;
      },
      get size() {
        return bodySize(state.body);
      },
      get readable() {
        return state.body.readable;
      },
      get sensitive() {
        return state.body.sensitive;
      },
      text() {
        ensureReadable(state.body, "Request body");
        if (state.body.kind !== "text") {
          throw sdkError("sdk_invalid_argument", "Request body is not text");
        }
        return state.body.text;
      },
      bytes() {
        ensureReadable(state.body, "Request body");
        if (state.body.kind === "none") return new Uint8Array();
        if (state.body.kind === "text") return utf8Encode(state.body.text);
        return base64Decode(state.body.base64);
      },
    };
    if (mutable) {
      api.clear = function clear() {
        state.body = { kind: "none", readable: true, sensitive: false };
      };
      api.setText = function setText(value) {
        const text = requireString(value, "body");
        const body = {
          kind: "text",
          text,
          readable: true,
          sensitive: containsSensitiveReference(text),
        };
        ensureBodyWithinLimit(body);
        state.body = body;
      };
      api.setBytes = function setBytes(value) {
        const bytes = requireBytes(value, "body");
        const body = {
          kind: "binary",
          base64: base64Encode(bytes),
          readable: true,
          sensitive: false,
        };
        ensureBodyWithinLimit(body);
        state.body = body;
      };
    }
    return Object.freeze(api);
  }

  const requestState = cloneJson(input.request);
  const requestHeaders = requestState.headers;
  const request = {};
  Object.defineProperties(request, {
    method: { enumerable: true, get: () => requestState.method },
    url: {
      enumerable: true,
      value: Object.freeze({
        get readable() {
          return requestState.url.readable;
        },
        get sensitive() {
          return requestState.url.sensitive;
        },
        get() {
          ensureReadable(requestState.url, "Request URL");
          return requestState.url.value;
        },
      }),
    },
    headers: {
      enumerable: true,
      value: createHeaderApi(requestHeaders, input.phase === "pre-request"),
    },
    body: {
      enumerable: true,
      value: createRequestBodyApi(requestState, input.phase === "pre-request"),
    },
  });
  if (input.phase === "pre-request") {
    Object.defineProperties(request, {
      setMethod: {
        enumerable: true,
        value(method) {
          requestState.method = requireNonEmptyString(method, "method");
        },
      },
      setUrl: {
        enumerable: true,
        value(value) {
          const url = requireString(value, "URL");
          requestState.url = {
            value: url,
            readable: true,
            sensitive: containsSensitiveReference(url),
          };
        },
      },
    });
  }
  Object.freeze(request);

  const variableWriteScopes = new Set(input.variableWritePolicy.allowedScopes);
  const variableWrites = new Map();
  const sensitiveWriteValues = new Set();

  function variableWriteBytes() {
    return utf8Encode(JSON.stringify(Array.from(variableWrites.values()))).byteLength;
  }

  function queueVariableWrite(name, value, options, kind) {
    const checkedName = requireNonEmptyString(name, "variable name");
    const checkedValue = requireString(value, "variable value");
    if (!variableName.test(checkedName)) {
      throw sdkError("sdk_invalid_argument", "Variable name is invalid");
    }
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw sdkError("sdk_invalid_argument", "variable write options must be an object");
    }
    const scope = requireNonEmptyString(options.scope, "variable write scope");
    if (!variableWriteScopes.has(scope)) {
      throw sdkError(
        "sdk_permission_denied",
        "Persistent variable writes to " + scope + " are not allowed",
      );
    }
    if (kind === "secret" && !input.variableWritePolicy.allowSecrets) {
      throw sdkError("sdk_permission_denied", "Persistent secret writes are not allowed");
    }
    const key = scope + "\u0000" + checkedName;
    const previous = variableWrites.get(key);
    variableWrites.set(key, { scope, name: checkedName, kind, value: checkedValue });
    try {
      if (variableWrites.size > input.limits.variableWriteCount) {
        throw sdkError("output_limit_exceeded", "Too many persistent variable writes");
      }
      if (variableWriteBytes() > input.limits.variableWriteBytes) {
        throw sdkError("output_limit_exceeded", "Persistent variable writes are too large");
      }
    } catch (error) {
      if (previous === undefined) variableWrites.delete(key);
      else variableWrites.set(key, previous);
      throw error;
    }
    if (kind === "secret" && checkedValue.length > 0) {
      sensitiveWriteValues.add(checkedValue);
    }
  }

  const variableApi = {
    has(name) {
      const item = variables.get(requireNonEmptyString(name, "variable name"));
      return item !== undefined && item.status === "resolved";
    },
    describe(name) {
      const checked = requireNonEmptyString(name, "variable name");
      const item = variables.get(checked);
      if (item === undefined) {
        return Object.freeze({
          name: checked,
          status: "missing",
          declaredKind: null,
          effectiveKind: null,
          sensitive: false,
          sourceScope: null,
        });
      }
      const copy = cloneJson(item);
      delete copy.value;
      return Object.freeze(copy);
    },
    get(name) {
      const checked = requireNonEmptyString(name, "variable name");
      const item = variables.get(checked);
      if (item === undefined || item.status === "missing" || item.status === "unset") {
        return undefined;
      }
      if (item.sensitive || item.effectiveKind === "secret") {
        throw sdkError(
          "sensitive_value_unavailable",
          "Variable " + checked + " contains sensitive material",
        );
      }
      if (item.status !== "resolved" || typeof item.value !== "string") {
        throw sdkError("runtime_error", "Variable " + checked + " could not be resolved");
      }
      return item.value;
    },
    require(name) {
      const checked = requireNonEmptyString(name, "variable name");
      const value = this.get(checked);
      if (value === undefined) {
        throw sdkError("runtime_error", "Variable " + checked + " is missing or unset");
      }
      return value;
    },
    reference(name) {
      const checked = requireNonEmptyString(name, "variable name");
      if (!variableName.test(checked)) {
        throw sdkError("sdk_invalid_argument", "Variable name is invalid");
      }
      return "<<" + checked + ">>";
    },
  };
  if (input.phase === "post-response") {
    variableApi.set = function set(name, value, options) {
      queueVariableWrite(name, value, options, "value");
    };
    variableApi.setSecret = function setSecret(name, value, options) {
      queueVariableWrite(name, value, options, "secret");
    };
  }
  Object.freeze(variableApi);

  const localState = Object.assign(Object.create(null), input.local || {});
  function localBytes(state) {
    return utf8Encode(JSON.stringify(state)).byteLength;
  }
  function validateLocalState(state) {
    if (Object.keys(state).length > input.limits.localVariableCount) {
      throw sdkError("output_limit_exceeded", "Too many execution-local variables");
    }
    if (localBytes(state) > input.limits.localVariableBytes) {
      throw sdkError("output_limit_exceeded", "Execution-local variables are too large");
    }
  }
  validateLocalState(localState);
  const localApi = Object.freeze({
    has(name) {
      return Object.hasOwn(localState, requireNonEmptyString(name, "local variable name"));
    },
    get(name) {
      return localState[requireNonEmptyString(name, "local variable name")];
    },
    set(name, value) {
      const checkedName = requireNonEmptyString(name, "local variable name");
      const checkedValue = requireString(value, "local variable value");
      const previous = localState[checkedName];
      localState[checkedName] = checkedValue;
      try {
        validateLocalState(localState);
      } catch (error) {
        if (previous === undefined) delete localState[checkedName];
        else localState[checkedName] = previous;
        throw error;
      }
    },
    remove(name) {
      delete localState[requireNonEmptyString(name, "local variable name")];
    },
    entries() {
      return Object.freeze(cloneJson(localState));
    },
  });

  let eventSequence = 0;
  function nextEventSequence() {
    eventSequence += 1;
    return eventSequence;
  }

  const logs = [];
  let logBytes = 0;
  function addLog(level, message, fields) {
    const entry = {
      sequence: nextEventSequence(),
      level,
      message: requireString(message, "log message"),
    };
    if (fields !== undefined) {
      if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
        throw sdkError("sdk_invalid_argument", "log fields must be an object");
      }
      const copy = {};
      for (const [name, value] of Object.entries(fields)) {
        if (
          value !== null &&
          typeof value !== "string" &&
          typeof value !== "number" &&
          typeof value !== "boolean"
        ) {
          throw sdkError("sdk_invalid_argument", "log field values must be scalar");
        }
        copy[name] = value;
      }
      entry.fields = copy;
    }
    const bytes = utf8Encode(JSON.stringify(entry)).byteLength;
    if (logs.length >= input.limits.logEntries || logBytes + bytes > input.limits.logBytes) {
      throw sdkError("output_limit_exceeded", "Script log limit exceeded");
    }
    logs.push(entry);
    logBytes += bytes;
  }
  const logApi = Object.freeze({
    debug(message, fields) {
      addLog("debug", message, fields);
    },
    info(message, fields) {
      addLog("info", message, fields);
    },
    warn(message, fields) {
      addLog("warn", message, fields);
    },
    error(message, fields) {
      addLog("error", message, fields);
    },
  });

  function assertionError(message, defaultMessage, messageCode) {
    const error = sdkError("runtime_error", message || defaultMessage);
    error.assertion = true;
    if (!message) error.messageCode = messageCode;
    return error;
  }

  const assertionApi = Object.freeze({
    ok(value, message) {
      if (!value) {
        throw assertionError(
          message,
          "Expected a truthy value",
          "assertion_expected_truthy",
        );
      }
    },
    equal(actual, expected, message) {
      if (!Object.is(actual, expected)) {
        throw assertionError(
          message,
          "Values are not equal",
          "assertion_values_not_equal",
        );
      }
    },
    deepEqual(actual, expected, message) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw assertionError(
          message,
          "Values are not deeply equal",
          "assertion_values_not_deeply_equal",
        );
      }
    },
    match(value, expression, message) {
      const checked = requireString(value, "value");
      if (!(expression instanceof RegExp)) {
        throw sdkError("sdk_invalid_argument", "expression must be a RegExp");
      }
      if (!expression.test(checked)) {
        throw assertionError(
          message,
          "Value does not match",
          "assertion_value_does_not_match",
        );
      }
    },
  });

  const tests = [];
  function test(name, body) {
    const checkedName = requireNonEmptyString(name, "test name");
    if (typeof body !== "function") {
      throw sdkError("sdk_invalid_argument", "test body must be a function");
    }
    try {
      body();
      tests.push({
        sequence: nextEventSequence(),
        name: checkedName,
        status: "passed",
      });
    } catch (error) {
      const messageCode =
        error && typeof error.messageCode === "string"
          ? error.messageCode
          : error instanceof Error
            ? undefined
            : "test_threw_non_error";
      tests.push({
        sequence: nextEventSequence(),
        name: checkedName,
        status: error && error.assertion ? "failed" : "errored",
        message: error instanceof Error ? error.message : "Test threw a non-error value",
        ...(messageCode === undefined ? {} : { messageCode }),
      });
    }
  }

  let response;
  if (input.phase === "post-response") {
    const responseState = cloneJson(input.response);
    const responseBody = Object.freeze({
      get size() {
        return responseState.body.size;
      },
      get sha256() {
        return responseState.body.sha256;
      },
      get available() {
        return responseState.body.available;
      },
      get unavailableReason() {
        return responseState.body.unavailableReason;
      },
      bytes() {
        if (!responseState.body.available) {
          throw sdkError("response_body_unavailable", "Response body is unavailable");
        }
        return base64Decode(responseState.body.base64 || "");
      },
      text() {
        return utf8Decode(this.bytes());
      },
    });
    response = Object.freeze({
      status: responseState.status,
      headers: createHeaderApi(responseState.headers, false),
      body: responseBody,
    });
  }

  const timeApi = Object.freeze({
    now() {
      return input.execution.startedAt;
    },
    unixMilliseconds() {
      return parseDate(input.execution.startedAt);
    },
  });

  const encodingApi = Object.freeze({
    utf8Encode,
    utf8Decode,
    base64Encode,
    base64Decode,
    hexEncode,
    hexDecode,
  });

  const sdk = {
    sdkVersion: input.sdkVersion,
    phase: input.phase,
    execution: Object.freeze(cloneJson(input.execution)),
    limits: Object.freeze(cloneJson(input.limits)),
    request,
    variables: variableApi,
    local: localApi,
    log: logApi,
    time: timeApi,
    encoding: encodingApi,
  };
  if (input.phase === "post-response") {
    sdk.response = response;
    sdk.assert = assertionApi;
    sdk.test = test;
  }
  Object.freeze(sdk);

  function serializeRequest() {
    return {
      method: requestState.method,
      url: cloneJson(requestState.url),
      headers: cloneJson(requestHeaders),
      body: cloneJson(requestState.body),
    };
  }

  function exportResult() {
    const result = {
      sdkVersion: input.sdkVersion,
      local: redactSensitiveWrites(cloneJson(localState)),
      logs: redactSensitiveWrites(cloneJson(logs)),
    };
    if (input.phase === "pre-request") result.request = serializeRequest();
    else {
      result.tests = redactSensitiveWrites(cloneJson(tests));
      result.variableWrites = cloneJson(Array.from(variableWrites.values()));
    }
    return result;
  }

  function redactSensitiveWrites(value) {
    if (typeof value === "string") {
      let redacted = value;
      for (const secret of sensitiveWriteValues) {
        redacted = redacted.split(secret).join("[secret]");
      }
      return redacted;
    }
    if (Array.isArray(value)) return value.map(redactSensitiveWrites);
    if (value !== null && typeof value === "object") {
      for (const key of Object.keys(value)) value[key] = redactSensitiveWrites(value[key]);
    }
    return value;
  }

  function redactText(value) {
    return redactSensitiveWrites(requireString(value, "text"));
  }

  function removeDynamicConstructor(value) {
    try {
      Object.defineProperty(Object.getPrototypeOf(value), "constructor", {
        configurable: false,
        enumerable: false,
        value: undefined,
        writable: false,
      });
    } catch {}
  }

  removeDynamicConstructor(function () {});
  removeDynamicConstructor(function* () {});
  removeDynamicConstructor(async function () {});
  removeDynamicConstructor(async function* () {});

  function hideGlobal(name) {
    Object.defineProperty(globalThis, name, {
      configurable: false,
      enumerable: false,
      value: undefined,
      writable: false,
    });
  }

  function protectGlobal(name) {
    const value = globalThis[name];
    if (value === undefined || value === null) return;
    if (value.prototype) Object.freeze(value.prototype);
    Object.freeze(value);
    Object.defineProperty(globalThis, name, {
      configurable: false,
      enumerable: false,
      value,
      writable: false,
    });
  }

  Object.defineProperty(Math, "random", {
    configurable: false,
    value: undefined,
    writable: false,
  });
  for (const name of [
    "eval",
    "Function",
    "Promise",
    "Date",
    "console",
    "setTimeout",
    "setInterval",
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "WebAssembly",
  ]) {
    hideGlobal(name);
  }
  for (const name of [
    "Object",
    "Array",
    "String",
    "Number",
    "Boolean",
    "RegExp",
    "Error",
    "Map",
    "Set",
    "Uint8Array",
    "JSON",
    "Math",
  ]) {
    protectGlobal(name);
  }

  return Object.freeze({ sdk, exportResult, redactText });
})
`;
