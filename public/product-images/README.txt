Drop your product images in this folder to use the "Image Repository" feature
(Attribute Fields → Image Repository, in the app).

## Naming convention

    {UPC}.{code}.{extension}

Where {code} identifies the orientation:

    .1  = Front view
    .2  = Left view
    .3  = Top view
    .7  = Back view
    .8  = Right view
    .9  = Base (Bottom) view

Example, for UPC 5010029000016:

    5010029000016.1.jpg   (Front)
    5010029000016.2.jpg   (Left)
    5010029000016.3.jpg   (Top)
    5010029000016.7.jpg   (Back)
    5010029000016.8.jpg   (Right)
    5010029000016.9.jpg   (Base)

You only need the files you actually have — the app skips any orientation it
can't find and only fills in what exists.

## Using it

1. In the app: Attribute Fields → Image Repository → check "Enabled"
2. Lookup Key: UPC (this is the default — matches the convention above)
3. Base URL: `/product-images/` (already the default — this folder, served by Vite)
4. Filename Pattern: `{key}.{code}` (default — matches the naming above)
5. File Extensions: `jpg,jpeg,png,webp` (tried in that order per image)
6. Go to Products → "Match Images from Repository" to bulk-fill every product
   missing images, or open a single product and use "Match from Repository" there.

Note: the app's Product Primary Key setting (used for bulk product/performance
imports) and the Image Repository's Lookup Key are separate settings — you can
match products by SKU while still looking up images by UPC, or vice versa.

## Using a cloud/CDN repository instead

Same idea — just change the Base URL to your cloud location (e.g.
`https://cdn.example.com/products/`) instead of this local folder. The naming
convention and everything else works the same way; this folder just won't be used.
