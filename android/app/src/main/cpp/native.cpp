#include <jni.h>
#include <node.h>
#include <string>
#include <vector>
#include <unistd.h>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <linux/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>

// libnode targets Android 24, so libuv compiles out statx and substitutes ctime
// for birthtime. Android 30+ permits statx; protected writes need its real btime.
static void Physical(const v8::FunctionCallbackInfo<v8::Value>& args) {
    auto isolate = args.GetIsolate();
    auto context = isolate->GetCurrentContext();
    struct statx value = {};
    int result;
    if (args.Length() && args[0]->IsInt32()) {
        result = syscall(__NR_statx, args[0].As<v8::Int32>()->Value(), "", AT_EMPTY_PATH, STATX_BASIC_STATS | STATX_BTIME, &value);
    } else if (args.Length() && args[0]->IsString()) {
        v8::String::Utf8Value name(isolate, args[0]);
        int flags = args.Length() > 1 && args[1]->IsTrue() ? 0 : AT_SYMLINK_NOFOLLOW;
        result = syscall(__NR_statx, AT_FDCWD, *name, flags, STATX_BASIC_STATS | STATX_BTIME, &value);
    } else {
        isolate->ThrowException(v8::Exception::TypeError(v8::String::NewFromUtf8Literal(isolate, "Expected a file path or descriptor")));
        return;
    }
    if (result != 0) {
        isolate->ThrowException(v8::Exception::Error(v8::String::NewFromUtf8(isolate, strerror(errno)).ToLocalChecked()));
        return;
    }
    if (!(value.stx_mask & STATX_BTIME)) { args.GetReturnValue().SetNull(); return; }
    auto output = v8::Object::New(isolate);
    auto set = [&](const char* name, uint64_t number) {
        auto text = std::to_string(number);
        output->Set(context, v8::String::NewFromUtf8(isolate, name).ToLocalChecked(), v8::String::NewFromUtf8(isolate, text.c_str()).ToLocalChecked()).Check();
    };
    set("dev", makedev(value.stx_dev_major, value.stx_dev_minor));
    set("ino", value.stx_ino);
    set("birthtimeNs", static_cast<uint64_t>(value.stx_btime.tv_sec) * 1000000000ULL + value.stx_btime.tv_nsec);
    args.GetReturnValue().Set(output);
}

static void Initialize(v8::Local<v8::Object> exports, v8::Local<v8::Value>, v8::Local<v8::Context>, void*) {
    NODE_SET_METHOD(exports, "physical", Physical);
}
NODE_MODULE_LINKED(neconyan_fs, Initialize)

extern "C" JNIEXPORT jint JNICALL
Java_io_github_platberlitz_neconyan_ServerService_startNode(JNIEnv* env, jclass, jobjectArray arguments, jstring cachePath) {
    const char* cache = env->GetStringUTFChars(cachePath, nullptr);
    setenv("TMPDIR", cache, 1);
    setenv("NODE_COMPILE_CACHE", (std::string(cache) + "/node-cache").c_str(), 1);
    setenv("NECONYAN_SUPERVISED", "1", 1);
    freopen((std::string(cache) + "/server.log").c_str(), "w", stdout);
    dup2(fileno(stdout), STDERR_FILENO);
    setvbuf(stdout, nullptr, _IOLBF, 0);
    env->ReleaseStringUTFChars(cachePath, cache);
    int count = env->GetArrayLength(arguments);
    std::vector<std::string> values;
    size_t size = 0;
    for (int i = 0; i < count; ++i) {
        auto item = static_cast<jstring>(env->GetObjectArrayElement(arguments, i));
        const char* value = env->GetStringUTFChars(item, nullptr);
        values.emplace_back(value);
        size += values.back().size() + 1;
        env->ReleaseStringUTFChars(item, value);
        env->DeleteLocalRef(item);
    }
    std::vector<char> storage(size);
    std::vector<char*> argv(count + 1, nullptr);
    char* cursor = storage.data();
    for (int i = 0; i < count; ++i) {
        argv[i] = cursor;
        memcpy(cursor, values[i].c_str(), values[i].size() + 1);
        cursor += values[i].size() + 1;
    }
    return node::Start(count, argv.data());
}
