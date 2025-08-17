import express from "express"
import "dotenv/config"
import router from "./src/routes/orcidRoute.js"
import paystackRoute from "./src/routes/paystackAuthRoute.js"
import cors from 'cors'

const app = express()

//middlewares
app.use(express.json())
const allowedOrigin = [
    'https://ijsds.org',
    'http://localhost:8080'
]
const corsOption = {
    origin : (origin,callback) => {
        if(allowedOrigin.indexOf(origin) !== -1 || !origin){
            callback(null,true)
        }else{
            callback(new Error("Not allowes by cors policy"))
        }
    }
}
app.use(cors(corsOption))
// app.use(cors())
app.use("/auth",router)
app.use("/api",paystackRoute)


export default app
// app.listen(4500)