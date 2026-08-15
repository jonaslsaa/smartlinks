#include <stdio.h>
#include <stdlib.h>

#include "quickjs.h"

static unsigned char *read_file(const char *path, size_t *length) {
  FILE *file = fopen(path, "rb");
  unsigned char *bytes;
  long size;

  if (!file || fseek(file, 0, SEEK_END) != 0 || (size = ftell(file)) < 0 ||
      fseek(file, 0, SEEK_SET) != 0) {
    return NULL;
  }
  bytes = malloc((size_t)size + 1);
  if (!bytes || fread(bytes, 1, (size_t)size, file) != (size_t)size) {
    free(bytes);
    fclose(file);
    return NULL;
  }
  fclose(file);
  bytes[size] = '\0';
  *length = (size_t)size;
  return bytes;
}

static void print_exception(JSContext *context) {
  JSValue exception = JS_GetException(context);
  const char *message = JS_ToCString(context, exception);
  fprintf(stderr, "%s\n", message ? message : "QuickJS compilation failed");
  JS_FreeCString(context, message);
  JS_FreeValue(context, exception);
}

int main(int argc, char **argv) {
  JSRuntime *runtime;
  JSContext *context;
  JSValue compiled;
  JSValue decoded;
  unsigned char *source;
  uint8_t *bytecode;
  size_t source_length;
  size_t bytecode_length;
  FILE *output;
  int status = 1;

  if (argc != 3) {
    fprintf(stderr, "usage: %s input.js output.bin\n", argv[0]);
    return 2;
  }
  source = read_file(argv[1], &source_length);
  if (!source) {
    fprintf(stderr, "Could not read %s\n", argv[1]);
    return 1;
  }

  runtime = JS_NewRuntime();
  context = runtime ? JS_NewContext(runtime) : NULL;
  if (!context) {
    fprintf(stderr, "Could not initialize QuickJS\n");
    free(source);
    JS_FreeRuntime(runtime);
    return 1;
  }
  JS_SetStripInfo(runtime, JS_STRIP_DEBUG);
  compiled = JS_Eval(context, (const char *)source, source_length, "smartlink.js",
                     JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
  free(source);
  if (JS_IsException(compiled)) {
    print_exception(context);
    goto cleanup;
  }

  bytecode = JS_WriteObject(context, &bytecode_length, compiled, JS_WRITE_OBJ_BYTECODE);
  if (!bytecode) {
    print_exception(context);
    goto free_compiled;
  }
  decoded = JS_ReadObject(context, bytecode, bytecode_length, JS_READ_OBJ_BYTECODE);
  if (JS_IsException(decoded)) {
    print_exception(context);
    js_free(context, bytecode);
    goto free_compiled;
  }
  JS_FreeValue(context, decoded);
  output = fopen(argv[2], "wb");
  if (!output || fwrite(bytecode, 1, bytecode_length, output) != bytecode_length) {
    fprintf(stderr, "Could not write %s\n", argv[2]);
  } else {
    status = 0;
  }
  if (output) {
    fclose(output);
  }
  js_free(context, bytecode);

free_compiled:
  JS_FreeValue(context, compiled);
cleanup:
  JS_FreeContext(context);
  JS_FreeRuntime(runtime);
  return status;
}
