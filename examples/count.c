int count(void) {
  int i = 0;
  while (i < 20) {
    i = i + 1;
    i*=2;
  }
  i = i-1;
  return i;
}
int sum(void) {
  int total = 0;
  for (int i = 0; i < 10; i = i + 1) {
    total = total + i;
  }
  return total;
}
