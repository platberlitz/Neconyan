#import <Foundation/Foundation.h>

@interface NodeRunner : NSObject
+ (void)startWithArguments:(NSArray<NSString *> *)arguments logPath:(NSString *)logPath;
@end
