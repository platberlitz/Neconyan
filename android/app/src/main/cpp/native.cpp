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
#include <pthread.h>

namespace {
// V8's default stack guard allows almost 1 MiB of JavaScript frames alone.
// An ART-created Java thread is not guaranteed to leave that much native stack
// available after JNI entry. Give Node its own stack, with room for C++/Wasm
// calls beyond the JavaScript guard. This reserves address space, not an 8 MiB heap.
constexpr size_t kNodeStackBytes = 8 * 1024 * 1024;
struct NodeLaunch {
    int argc;
    char** argv;
    std::string diagnostics;
    int result = 1;
};

void* RunNode(void* opaque) {
    auto& launch = *static_cast<NodeLaunch*>(opaque);
    pthread_attr_t attributes;
    size_t bytes = 0;
    if (pthread_getattr_np(pthread_self(), &attributes) == 0) {
        pthread_attr_getstacksize(&attributes, &bytes);
        pthread_attr_destroy(&attributes);
    }
    if (FILE* report = fopen(launch.diagnostics.c_str(), "w")) {
        fprintf(report, "Node runs on a dedicated native thread. Stack: %zu KiB.\n", bytes / 1024);
        fclose(report);
    }
    printf("Native server stack: %zu KiB\n", bytes / 1024);
    launch.result = node::Start(launch.argc, launch.argv);
    return nullptr;
}
}

// libnode targets Android 24, so libuv compiles out statx and substitutes ctime
// for birthtime. Android 30+ permits statx. Returns null when the filesystem has
// no btime (f2fs without inode_crtime); file-stats.mjs then uses a constant zero.
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
    std::string diagnostics = std::string(cache) + "/native-startup.txt";
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
    // Keep the argument storage alive on the calling thread until Node returns.
    // The native thread never accesses JNI objects or attaches to the Java VM.
    NodeLaunch launch{count, argv.data(), diagnostics};
    pthread_attr_t attributes;
    int error = pthread_attr_init(&attributes);
    pthread_t thread;
    if (error == 0) {
        error = pthread_attr_setstacksize(&attributes, kNodeStackBytes);
        if (error == 0) error = pthread_create(&thread, &attributes, RunNode, &launch);
        pthread_attr_destroy(&attributes);
    }
    if (error != 0) {
        std::string message = std::string("Cannot start the native server thread: ") + strerror(error);
        env->ThrowNew(env->FindClass("java/io/IOException"), message.c_str());
        return 1;
    }
    // This is a joinable thread created here; no other caller can join it.
    if (pthread_join(thread, nullptr) != 0) std::abort();
    return launch.result;
}
