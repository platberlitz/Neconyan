#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface NodeRunner : NSObject
+ (void)startWithArguments:(NSArray<NSString *> *)arguments logPath:(NSString *)logPath;
/// Node runs inside the app process, so it can only start once per launch.
@property (class, readonly) BOOL hasExited;
@property (class, readonly) int exitCode;
@end

/// AVFoundation reports some failures as Objective-C exceptions, which Swift cannot catch.
@interface NeconyanObjC : NSObject
+ (nullable NSString *)catchException:(NS_NOESCAPE void (^)(void))block;
@end

NS_ASSUME_NONNULL_END
