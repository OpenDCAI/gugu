// Development files only; license notices and runtime native binaries remain packaged.
module.exports = [
  '!node_modules/**/*.{iobj,ipdb,exp,ilk,obj,tlog}',
  '!node_modules/**/build/Release/*.lib',
  '!node_modules/**/*.{ts,mts,cts}',
  '!node_modules/**/{test,tests,__tests__,__mocks__,spec}/**',
  '!node_modules/**/!([Ll][Ii][Cc][Ee][Nn][Ss][Ee]*|[Nn][Oo][Tt][Ii][Cc][Ee]*|[Cc][Oo][Pp][Yy][Ii][Nn][Gg]*).{md,markdown}',
  '!node_modules/**/*.{c,h,cc,cpp,hpp}',
  '!node_modules/**/build/Release/obj/**',
  '!node_modules/**/build/*.{mk,gyp,gypi}',
]
