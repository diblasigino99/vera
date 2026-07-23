import { ImageResponse } from "next/og";

export const alt = "Nexra AI";
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
            fontFamily: "Georgia, serif",
            fontSize: 112,
            fontWeight: 600,
            letterSpacing: "-0.055em",
            lineHeight: 1
          }}
        >
          Nexra AI
        </div>
        <div
          style={{
            color: "#62626A",
            fontFamily: "Arial, sans-serif",
            fontSize: 34,
            lineHeight: 1.35,
            marginTop: 34
          }}
        >
          Focused AI products for clearer decisions.
        </div>
      </div>
    ),
    size
  );
}
