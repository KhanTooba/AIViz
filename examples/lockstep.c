/* Two counters incrementing in lockstep under an unbounded loop. Neither
   counter has a bounded range (n is an untracked parameter), but j - i = 1
   never changes — a relational domain (Zones, Octagons) can keep this fact
   even though it cannot bound either variable alone. Intervals cannot
   express the relation at all.

   j is initialized as i + 1, not the equal-valued literal 1: an explicit
   expression relating i and j is what actually lets a relational domain
   derive the invariant, rather than relying on two independent constant
   pins happening to line up. */
int f(int n) {
  int i = 0;
  int j = i + 1;
  while (i < n) {
    i = i + 1;
    j = j + 1;
  }
  return j;
}
