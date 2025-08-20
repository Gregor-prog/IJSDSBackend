import { createClient } from "@supabase/supabase-js";
import axios from "axios";
import mammoth from "mammoth";

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ROLE_KEY
);

const fetchFile = async (fileUrl) => {
  try {
    const response = await fetch(fileUrl)
  if(!response.ok){
    throw "couldn't fetch file"
  }
  const arrayBuffer = await response.arrayBuffer()
  const buffer = Buffer.from(arrayBuffer)

  // convert to HTML using mammoth
  const {value,messages} = await mammoth.convertToHtml({
    buffer
  })
  if(messages.length > 0){
    console.warn(`conversion warning : ${messages}`)
  }
  return value
  } catch (error) {
    if(error){
      res.status(404).json({
        success:false,
        message:"error",
        error:error.message
      })
    }
  }
}

export default fetchFile