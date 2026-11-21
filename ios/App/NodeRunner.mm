#import "NodeRunner.h"
#import <NodeMobile/NodeMobile.h>
#include <stdio.h>
#include <sys/stat.h>
#include <errno.h>
#include <atomic>

static std::atomic<bool> nodeExited(false);
static std::atomic<int> nodeExitCode(0);

@implementation NodeRunner
+ (BOOL)hasExited { return nodeExited.load(); }
+ (int)exitCode { return nodeExitCode.load(); }

+ (void)startWithArguments:(NSArray<NSString *> *)arguments logPath:(NSString *)logPath {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSThread *thread = [[NSThread alloc] initWithBlock:^{
            freopen(logPath.fileSystemRepresentation, "a", stdout);
            freopen(logPath.fileSystemRepresentation, "a", stderr);
            setvbuf(stdout, NULL, _IOLBF, 0);
            setvbuf(stderr, NULL, _IOLBF, 0);
            // Node's heap flag comes before the entry script.
            NSString *entryPath = arguments[2];
            struct stat entry;
            int entryStatus = stat(entryPath.fileSystemRepresentation, &entry);
            fprintf(stderr, "Neconyan startup: entry file stat=%d errno=%d\n", entryStatus, entryStatus == 0 ? 0 : errno);
            int argc = (int)arguments.count;
            char **argv = (char **)calloc(argc + 1, sizeof(char *));
            for (int i = 0; i < argc; i++) argv[i] = strdup(arguments[i].UTF8String);
            int result = node_start(argc, argv);
            fprintf(stderr, "Neconyan startup: Node exited with code=%d\n", result);
            nodeExitCode.store(result);
            nodeExited.store(true);
            for (int i = 0; i < argc; i++) free(argv[i]);
            free(argv);
        }];
        thread.name = @"Neconyan server";
        thread.stackSize = 8 * 1024 * 1024;
        thread.qualityOfService = NSQualityOfServiceUserInitiated;
        [thread start];
    });
}
@end

@implementation NeconyanObjC
+ (NSString *)catchException:(NS_NOESCAPE void (^)(void))block {
    @try {
        block();
        return nil;
    } @catch (NSException *exception) {
        return [NSString stringWithFormat:@"%@: %@", exception.name, exception.reason ?: @"no reason"];
    }
}
@end
