int count(void) {
  int i = 0;
  while (i < 20) {
    i = i + 1;
    i*=2;
  }
  i = i-1;
  return i;
}
