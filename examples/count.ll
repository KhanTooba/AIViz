; Textual LLVM IR example for the bundled AIViz LLVM provider.
define i32 @count() {
entry:
  br label %loop

loop:
  %i = phi i32 [ 0, %entry ], [ %next, %body ]
  %keep_going = icmp slt i32 %i, 20
  br i1 %keep_going, label %body, label %exit

body:
  %next = add i32 %i, 1
  br label %loop

exit:
  ret i32 %i
}
