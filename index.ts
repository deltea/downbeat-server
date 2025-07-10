import express, { type Request, type Response } from "express";
import multer from "multer";
import { spawn } from "child_process";
import gifFrames from "gif-frames";
import cors from "cors";
import path from "path";

const app = express();
const port = 8000;

const upload = multer({ limits: { fileSize: 50 * 1024 * 1024 } });
const uploadMiddleware = upload.fields([{ name: "gif", maxCount: 1 }, { name: "audio", maxCount: 1 }]);

app.use(cors({
  origin: "*",
  methods: ["POST"],
  allowedHeaders: ["Content-Type"]
}));
app.use(uploadMiddleware);

app.post("/", async (req: Request, res: Response) => {
  const { timePerBeat, audioDuration }: {
    timePerBeat: string,
    audioDuration: string
  } = req.body;

  console.log(req.body);

  const files = req.files as { [fieldname: string]: Express.Multer.File[] };
  const gif = files["gif"]?.[0];
  const audio = files["audio"]?.[0];

  if (!gif) return new Response("no video uploaded", { status: 400 });
  if (!audio) return new Response("no audio uploaded", { status: 400 });

  const gifPath = `/tmp/input.gif`;
  const audioPath = `/tmp/audio.mp3`;
  const videoPath = `/tmp/video.mp4`;
  const finalPath = `/tmp/final.mp4`;
  const fileListPath = `/tmp/filelist.txt`;

  await Bun.write(gifPath, gif.buffer);
  await Bun.write(audioPath, audio.buffer);

  const frames: [{ getImage: () => NodeJS.ReadableStream }] = await gifFrames({
    url: gifPath,
    frames: "all",
    outputType: "png"
  });

  const duration = +timePerBeat / frames.length;

  console.log(`${frames.length} frames extracted from gif`);

  let fileListText = "";
  const framePaths: string[] = [];
  for (let i = 0; i < frames.length; i++) {
    const img = frames[i]?.getImage();
    if (!img) continue;
    const framePath = path.join("/tmp", `frame-${i}.png`);
    await Bun.write(framePath, await streamToBuffer(img));

    console.log(`writing frame ${i} to disk`);
    framePaths.push(framePath);
  }

  const beats = Math.ceil(+audioDuration / +timePerBeat);
  for (let beat = 0; beat < beats; beat++) {
    for (const frame of framePaths) {
      fileListText += `file ${frame}\n`;
      fileListText += `duration ${duration.toFixed(4)}\n`;
    }
  }

  await Bun.write(fileListPath, fileListText);

  // turn gif into mp4
  await runFFmpeg([
    "-f", "concat",
    "-safe", "0",
    "-i", fileListPath,
    "-vsync", "vfr",
    "-pix_fmt", "yuv420p",
    "-c:v", "libx264",
    "-movflags", "faststart",
    "-vf", "format=rgba,scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos,format=yuv420p",
    "-y", videoPath
  ]);

  await runFFmpeg([
    "-i", videoPath,
    "-i", audioPath,
    "-c:v", "copy",
    "-c:a", "aac",
    "-shortest",
    "-y", finalPath
  ]);

  return res.download(finalPath, "output.mp4", (err) => {
    if (err) {
      console.error("error downloading file: ", err);
      res.status(500).send("error downloading file");
    } else {
      console.log("file downloaded successfully");
    }
  });
});

async function runFFmpeg(args: string[]) {
  return new Promise<number>((resolve, reject) => {
    const ff = spawn("ffmpeg", args);

    ff.stderr.on("data", data => console.log(data.toString()));
    ff.on("close", code => (code === 0 ? resolve(0) : reject(code)));
  });
}

function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

app.listen(port, () => {
  console.log(`running on ${port}`);
});
