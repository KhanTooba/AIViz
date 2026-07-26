declare i32 @g(i32)

define i32 @f(i32 %n) {
entry:
  %r = call i32 @g(i32 %n)
  ret i32 %r
}
