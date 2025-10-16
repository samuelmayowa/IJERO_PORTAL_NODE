
import path from 'path';
import { generateTranscriptPDF } from '../../services/transcript.service.js';
import { sendMail } from '../../services/email.service.js';

export const generateForm=(req,res)=>res.render('pages/transcripts-generate');
export const generateSubmit=async (req,res)=>{
  const matric = (req.body.matric || '').trim();
  const out = await generateTranscriptPDF({ matric, outDir: path.join('app','web','public','transcripts') });
  res.redirect('/transcripts/view');
};
export const viewList=(req,res)=> res.render('pages/transcripts-view'); // could list files on disk
export const downloadOne=(req,res)=>{
  const id = req.params.id;
  res.download(path.join('app','web','public','transcripts', id));
};
export const sendForm=(req,res)=>res.render('pages/transcripts-send');
export const sendSubmit=async (req,res)=>{
  const { to, file } = req.body;
  await sendMail({ to, subject: 'Transcript', text: 'Please find attached transcript.', attachments: [{ filename: file, path: path.join('app','web','public','transcripts', file)}]});
  res.redirect('/transcripts/view');
};
