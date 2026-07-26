define i32 @f() {
entry:
  br label %loop
loop:
  %i = phi i32 [ 0, %entry ], [ %i.next, %body ]
  %cond = icmp slt i32 %i, 10
  br i1 %cond, label %body, label %exitblock
body:
  %i.next = add i32 %i, 1
  br label %loop
exitblock:
  ret i32 %i
}
