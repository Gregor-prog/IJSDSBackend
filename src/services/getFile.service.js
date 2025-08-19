import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ROLE_KEY
);

const fetchFile = async (fileUrl) => {
    const {data,error} = await supabase.storage
    .from('journal-website-db1').download(fileUrl)

    if(error) throw error
    const buffer = Buffer.from(await data.arrayBuffer())
    return buffer
}

export default fetchFile