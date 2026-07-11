// import './utils/dnsConfig.js'
import dotenv from "dotenv";
dotenv.config({
    path: `.env.${process.env.NODE_ENV || "development"}`
});
const { default: app } = await import("./app.js");
const { default: connectDB } = await import("./database/database.js");

connectDB().then(()=>{
    app.listen(process.env.PORT || 8000, process.env.SERVER_HOST, async ()=>{
        console.log(`Server is running at on : http://${process.env.SERVER_HOST}:${process.env.PORT}`);
    })
}).catch((err)=>{
    console.log('MongoDB Failed !!!', err);
});