/* Joins without a loop: no widening is needed, so the analysis converges
   in a single pass and every step is a transfer or a join. */
int classify(int n) {
  int r = 0;
  if (n > 0) {
    r = 1;
  } else {
    r = 2;
  }
  return r;
}

/* A nested loop has two widening points, one per loop header. */
int nested(void) {
  int i = 0;
  int total = 0;
  while (i < 10) {
    int j = 0;
    while (j < 5) {
      total = total + 1;
      j = j + 1;
    }
    i = i + 1;
  }
  return total;
}
