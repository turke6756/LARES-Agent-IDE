#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SOURCE="$SCRIPT_DIR/../Lares_Website_Scroll/Left Hand Pane Files .mp4"
OUTPUT="$SCRIPT_DIR/media"

mkdir -p "$OUTPUT"

ffmpeg -y -i "$SOURCE" -vf "crop=690:1995:0:165,scale=420:-2:flags=lanczos" \
  -an -c:v libx264 -preset slow -crf 25 -pix_fmt yuv420p -movflags +faststart \
  "$OUTPUT/act-1-left-pane.mp4"

ffmpeg -y -i "$SOURCE" -vf "crop=690:1995:0:165,scale=280:-2:flags=lanczos" \
  -an -c:v libx264 -preset slow -crf 27 -pix_fmt yuv420p -movflags +faststart \
  "$OUTPUT/act-1-left-pane-mobile.mp4"

ffmpeg -y -ss 0.8 -i "$SOURCE" -frames:v 1 \
  -vf "crop=690:1995:0:165,scale=420:-2:flags=lanczos" -q:v 4 -update 1 \
  "$OUTPUT/act-1-left-pane-poster.jpg"

ffmpeg -y -ss 0.8 -i "$SOURCE" -frames:v 1 \
  -vf "crop=690:1995:0:165,scale=420:-2:flags=lanczos" -c:v libwebp -quality 78 \
  "$OUTPUT/act-1-left-pane-poster.webp"

ffmpeg -y -ss 0.8 -i "$SOURCE" -frames:v 1 \
  -vf "crop=690:1995:0:165,scale=280:-2:flags=lanczos" -c:v libwebp -quality 76 \
  "$OUTPUT/act-1-left-pane-poster-mobile.webp"

ACT_2_SOURCE="$SCRIPT_DIR/../Lares_Website_Scroll/Agent Cards.mp4"
ACT_2_FILTER="crop=2290:1995:704:165"

ffmpeg -y -i "$ACT_2_SOURCE" -vf "$ACT_2_FILTER,scale=760:-2:flags=lanczos" \
  -an -c:v libx264 -preset slow -crf 25 -pix_fmt yuv420p -movflags +faststart \
  "$OUTPUT/act-2-agent-cards.mp4"

ffmpeg -y -i "$ACT_2_SOURCE" -vf "$ACT_2_FILTER,scale=520:-2:flags=lanczos" \
  -an -c:v libx264 -preset slow -crf 27 -pix_fmt yuv420p -movflags +faststart \
  "$OUTPUT/act-2-agent-cards-mobile.mp4"

ffmpeg -y -ss 1.2 -i "$ACT_2_SOURCE" -frames:v 1 \
  -vf "$ACT_2_FILTER,scale=760:-2:flags=lanczos" -q:v 4 -update 1 \
  "$OUTPUT/act-2-agent-cards-poster.jpg"

ffmpeg -y -ss 1.2 -i "$ACT_2_SOURCE" -frames:v 1 \
  -vf "$ACT_2_FILTER,scale=760:-2:flags=lanczos" -c:v libwebp -quality 78 \
  "$OUTPUT/act-2-agent-cards-poster.webp"

ffmpeg -y -ss 1.2 -i "$ACT_2_SOURCE" -frames:v 1 \
  -vf "$ACT_2_FILTER,scale=520:-2:flags=lanczos" -c:v libwebp -quality 76 \
  "$OUTPUT/act-2-agent-cards-poster-mobile.webp"

printf 'Encoded media written to %s\n' "$OUTPUT"
