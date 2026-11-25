# Fonts

Sofia Sans and Sofia Sans Condensed by Lettersoup (Botio Nikoltchev, Ani Petrova).
Copyright 2019 The Sofia Sans Project Authors (https://github.com/lettersoup/Sofia-Sans).
Licensed under the SIL Open Font License 1.1 — https://openfontlicense.org

The files here are subsets (Latin + Turkish characters, variable weight axis kept),
converted from the original variable TTFs with fontTools:

    pyftsubset SofiaSans-VariableFont_wght.ttf \
      --unicodes="U+0020-007E,U+00A0-00FF,U+0100-017F,U+0218-021B,U+02C6,U+02DA,U+02DC,U+2010-2027,U+2030,U+2039-203A,U+20AC,U+2122,U+2190-2193,U+2212,U+2715" \
      --layout-features='kern,liga,calt,ccmp,locl,mark,mkmk,tnum,lnum,case' \
      --flavor=woff --output-file=sofia-sans.woff

Add OFL.txt from the Google Fonts download next to these files when publishing.
When a new language is added, re-run the subset with its character ranges.
