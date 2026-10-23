Star Puff / 星绒绒 - electronic creature illustration pack

Transparent PNG and editable SVG characters based on the supplied plush star.
Available expressions: wink, calm, happy, sleepy, surprised, sad, angry, love.
The transparent sprite atlas is star_puff_spritesheet.png (4 columns x 2 rows, 512px cell).
Each PNG is 512x512 except wink (1024x1024).
Avatar: star_puff_character.png (1024x1024).
SVG illustrations are 1000x1000 scalable.

Recommended use with current Canvas-based repository:
const petImage = new Image();
petImage.src = './assets/star_puff_wink.png';
petImage.onload = () => ctx.drawImage(petImage, x-32, y-32, 64, 64);
Load images once; do not instantiate Image during frame rendering.

All visual elements have transparent backgrounds; no external font or asset dependencies.
