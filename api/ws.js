export default function handler(req, res) {
  res.status(200).json({
    status: "RCL WebSocket server",
    message: "Server is online"
  });
}
