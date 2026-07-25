/* A for loop. Its header line maps to several CFG blocks at once:
   the condition and the latch carrying `i = i + 1`. */
int sum(void) {
  int total = 0;
  for (int i = 0; i < 10; i = i + 1) {
    total = total + i;
  }
  return total;
}
