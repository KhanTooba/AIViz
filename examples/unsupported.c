/* Every function here is rejected by the precheck, each for a different
   reason, with the exact line reported. */

int deref(int *p) {
  return *p;
}

int indexing(void) {
  int a[10];
  return a[0];
}

int floating(void) {
  float x = 1.5;
  return 0;
}

int helper(void);

int calls(void) {
  return helper();
}
