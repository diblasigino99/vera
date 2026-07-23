import { ImageResponse } from "next/og";

export const alt = "Vera";
export const size = {
  width: 1200,
  height: 630
};
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background: "#FFFFFF",
          color: "#111114",
          display: "flex",
          flexDirection: "column",
          height: "100%",
          justifyContent: "center",
          width: "100%"
        }}
      >
        <div
          style={{
            color: "#B3B3B8",
            fontFamily: "Arial, sans-serif",
            fontSize: 22,
            fontWeight: 600,
            letterSpacing: "0.34em",
            lineHeight: 1,
            textTransform: "uppercase"
          }}
        >
          Nexra AI Presents
        </div>
        <div
          style={{
            fontFamily: "Georgia, serif",
            fontSize: 170,
            fontWeight: 600,
            letterSpacing: "-0.06em",
            lineHeight: 0.95,
            marginTop: 42
          }}
        >
          Vera
        </div>
        <div
          style={{
            color: "#62626A",
            fontFamily: "Arial, sans-serif",
            fontSize: 36,
            lineHeight: 1.35,
            marginTop: 42
          }}
        >
          See where the internet agrees - and where it doesn't.
        </div>
      </div>
    ),
    size
  );
}
