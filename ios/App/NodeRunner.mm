#import "NodeRunner.h"
#import <NodeMobile/NodeMobile.h>
#include <stdio.h>
#include <sys/stat.h>
#include <errno.h>

@implementation NodeRunner
+ (void)startWithArguments:(NSArray<NSString *> *)arguments logPath:(NSString *)logPath {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSThread *thread = [[NSThread alloc] initWithBlock:^{
            freopen(logPath.fileSystemRepresentation, "a", stdout);
            freopen(logPath.fileSystemRepresentation, "a", stderr);
            setvbuf(stdout, NULL, _IOLBF, 0);
            setvbuf(stderr, NULL, _IOLBF, 0);
            struct stat entry;
            int entryStatus = stat(arguments[1].fileSystemRepresentation, &entry);
            fprintf(stderr, "Neconyan startup: entry file stat=%d errno=%d\n", entryStatus, entryStatus == 0 ? 0 : errno);
            int argc = (int)arguments.count;
            char **argv = (char **)calloc(argc + 1, sizeof(char *));
            for (int i = 0; i < argc; i++) argv[i] = strdup(arguments[i].UTF8String);
            node_start(argc, argv);
            for (int i = 0; i < argc; i++) free(argv[i]);
            free(argv);
        }];
        thread.name = @"Neconyan server";
        thread.stackSize = 8 * 1024 * 1024;
        [thread start];
    });
}
@end
