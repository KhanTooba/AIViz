cd paper/6a9583b5b0621b54ee3879d1
git add --all
git commit -m "${1:-Update AIViz paper draft}"
git push 
cd ../../


# Then run:
# # ./commitPaper.sh "Add paper skeleton and introduction"