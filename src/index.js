// import './utils/dnsConfig.js'
import "./config/env.js";
import http from "http";
import { Server } from "socket.io";
import app from "./app.js";
import connectDB from "./database/database.js";
import "./config/i18n.js";
import { registerMatchSocket } from "./sockets/match.socket.js";
import { registerAuctionSocket } from "./sockets/auction.socket.js";

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CORS_ORIGIN, credentials: true } });
app.set('io', io);
registerMatchSocket(io);
registerAuctionSocket(io);

connectDB().then(()=>{
    server.listen(process.env.PORT || 8000, process.env.SERVER_HOST, async ()=>{
        console.log(`Server is running at on : http://${process.env.SERVER_HOST}:${process.env.PORT}`);
    })
}).catch((err)=>{
    console.log('MongoDB Failed !!!', err);
});